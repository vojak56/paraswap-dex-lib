import { Interface } from '@ethersproject/abi';
import { DeepReadonly } from 'ts-essentials';
import _ from 'lodash';
import {
  Token,
  Address,
  ExchangePrices,
  PoolPrices,
  Log,
  AdapterExchangeParam,
  SimpleExchangeParam,
  PoolLiquidity,
  Logger,
} from '../../types';
import {
  SwapSide,
  ETHER_ADDRESS,
  NULL_ADDRESS,
  MAX_INT,
  MAX_UINT,
  Network,
  SUBGRAPH_TIMEOUT,
} from '../../constants';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { StablePool, WeightedPool } from './balancer-v2-pool';
import { PhantomStablePool } from './PhantomStablePool';
import { LinearPool } from './LinearPool';
import VaultABI from '../../abi/balancer-v2/vault.json';
import { StatefulEventSubscriber } from '../../stateful-event-subscriber';
import { getDexKeysWithNetwork, getBigIntPow } from '../../utils';
import { IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper';
import {
  PoolState,
  SubgraphPoolBase,
  BalancerV2Data,
  BalancerParam,
  OptimizedBalancerV2Data,
  SwapTypes,
  PoolStateMap,
  PoolStateCache,
} from './types';
import { SimpleExchange } from '../simple-exchange';
import { BalancerConfig, Adapters } from './config';

const fetchAllPools = `query ($count: Int) {
  pools: pools(first: $count, orderBy: totalLiquidity, orderDirection: desc, where: {swapEnabled: true, poolType_in: ["MetaStable", "Stable", "Weighted", "LiquidityBootstrapping", "Investment", "StablePhantom", "AaveLinear", "ERC4626Linear"]}) {
    id
    address
    poolType
    tokens {
      address
      decimals
    }
    mainIndex
    wrappedIndex
  }
}`;

const fetchWeightUpdating = `query ($count: Int, $timestampPast: Int, $timestampFuture: Int) {
  gradualWeightUpdates(
    first: $count,
    where: {startTimestamp_lt: $timestampFuture, endTimestamp_gt: $timestampPast }
  ) {
    poolId {
      address
    }
  }
}`;

// These should match the Balancer Pool types available on Subgraph
enum BalancerPoolTypes {
  Weighted = 'Weighted',
  Stable = 'Stable',
  MetaStable = 'MetaStable',
  LiquidityBootstrapping = 'LiquidityBootstrapping',
  Investment = 'Investment',
  AaveLinear = 'AaveLinear',
  StablePhantom = 'StablePhantom',
  ERC4626Linear = 'ERC4626Linear',
}

const MAX_POOL_CNT = 1000; // Taken from SOR
const POOL_CACHE_TTL = 60 * 60; // 1 hr
const POOL_EVENT_DISABLED_TTL = 5 * 60; // 5 min
const POOL_EVENT_REENABLE_DELAY = 7 * 24 * 60 * 60; // 1 week

class BalancerV2PoolState extends StatefulEventSubscriber<PoolState> {
  public poolAddress: string;

  constructor(
    dexHelper: IDexHelper,
    parentName: string,
    key: string,
    logger: Logger,
    public info: SubgraphPoolBase,
    private pool: WeightedPool | StablePool | LinearPool | PhantomStablePool,
  ) {
    super(dexHelper, parentName, key, logger, true);
    this.poolAddress = info.address.toLowerCase();
  }

  async generateState(blockNumber: number): Promise<Readonly<PoolState>> {
    this.logger.warn('balancer-v2 generating new state');
    const calls = this.pool.getOnChainCalls(this.info);
    const results = await this.dexHelper.multiContract.methods
      .tryAggregate(true, calls)
      .call({}, blockNumber);

    const newState = this.pool.decodeOnChainCalls(this.info, results, 0);

    return newState[0];
  }

  protected processLog(
    state: DeepReadonly<PoolState>,
    log: Readonly<Log>,
  ): DeepReadonly<PoolState> | null {
    return null;
  }

  handleSwap(event: any, blockNumber: number): void {
    const state = _.cloneDeep(this.getState(blockNumber)) as PoolState;

    const tokenIn = event.args.tokenIn.toLowerCase();
    const amountIn = BigInt(event.args.amountIn.toString());
    const tokenOut = event.args.tokenOut.toLowerCase();
    const amountOut = BigInt(event.args.amountOut.toString());
    state.tokens[tokenIn].balance += amountIn;
    state.tokens[tokenOut].balance -= amountOut;

    this.setState(state, blockNumber);
  }

  handlePoolBalanceChanged(event: any, blockNumber: number): void {
    const state = _.cloneDeep(this.getState(blockNumber)) as PoolState;

    const tokens = event.args.tokens.map((t: string) => t.toLowerCase());
    const deltas = event.args.deltas.map((d: any) => BigInt(d.toString()));
    const fees = event.args.protocolFeeAmounts.map((d: any) =>
      BigInt(d.toString()),
    ) as bigint[];
    tokens.forEach((t: string, i: number) => {
      const diff = deltas[i] - fees[i];
      state.tokens[t].balance += diff;
    });

    this.setState(state, blockNumber);
  }
}

export class BalancerV2EventPool extends StatefulEventSubscriber<PoolStateMap> {
  public vaultInterface: Interface;

  private poolsState: Record<string, BalancerV2PoolState> = {};

  handlers: {
    [event: string]: (
      event: any,
      pool: BalancerV2PoolState,
      blockNumber: number,
    ) => void;
  } = {};

  pools: {
    [type: string]: WeightedPool | StablePool | LinearPool | PhantomStablePool;
  };

  allEventBasedPools: { [address: string]: BalancerV2PoolState } = {};
  allPools: SubgraphPoolBase[] = [];

  vaultDecoder: (log: Log) => any;

  addressesSubscribed: string[];

  eventSupportedPoolTypes = [
    'Stable',
    'Weighted',
    'LiquidityBootstrapping',
    'Investment',
  ];

  eventRemovedPools = (
    [
      // Gradual weight changes are not currently handled in event system
      // This pool keeps changing weights and is causing pricing issue
      // But should now be handled by eventDisabledPools so don't need here!
      //'0x34809aEDF93066b49F638562c42A9751eDb36DF5',
    ] as Address[]
  ).map(s => s.toLowerCase());

  constructor(
    protected dexHelper: IDexHelper,
    protected parentName: string,
    protected vaultAddress: Address,
    protected subgraphURL: string,
    logger: Logger,
  ) {
    super(dexHelper, parentName, vaultAddress, logger);

    this.vaultInterface = new Interface(VaultABI);
    const weightedPool = new WeightedPool(
      this.vaultAddress,
      this.vaultInterface,
    );
    const stablePool = new StablePool(this.vaultAddress, this.vaultInterface);
    const stablePhantomPool = new PhantomStablePool(
      this.vaultAddress,
      this.vaultInterface,
    );
    const linearPool = new LinearPool(this.vaultAddress, this.vaultInterface);

    this.pools = {};
    this.pools[BalancerPoolTypes.Weighted] = weightedPool;
    this.pools[BalancerPoolTypes.Stable] = stablePool;
    this.pools[BalancerPoolTypes.MetaStable] = stablePool;
    this.pools[BalancerPoolTypes.LiquidityBootstrapping] = weightedPool;
    this.pools[BalancerPoolTypes.Investment] = weightedPool;
    this.pools[BalancerPoolTypes.AaveLinear] = linearPool;
    // ERC4626Linear has the same maths and ABI as AaveLinear (has different factory)
    this.pools[BalancerPoolTypes.ERC4626Linear] = linearPool;
    this.pools[BalancerPoolTypes.StablePhantom] = stablePhantomPool;
    this.vaultDecoder = (log: Log) => this.vaultInterface.parseLog(log);
    this.addressesSubscribed = [vaultAddress];

    // Add default handlers
    this.handlers['Swap'] = this.handleSwap.bind(this);
    this.handlers['PoolBalanceChanged'] =
      this.handlePoolBalanceChanged.bind(this);
  }

  handleSwap(event: any, pool: BalancerV2PoolState, blockNumber: number) {
    pool.handleSwap(event, blockNumber);
  }

  handlePoolBalanceChanged(
    event: any,
    pool: BalancerV2PoolState,
    blockNumber: number,
  ) {
    pool.handlePoolBalanceChanged(event, blockNumber);
  }

  async generateState(blockNumber: number): Promise<Readonly<PoolStateMap>> {
    const pools = Object.values(this.poolsState);
    const states = await this.getOnChainState(
      pools.map(pool => pool.info),
      blockNumber,
    );

    pools.forEach((pool, index) => {
      if (states[index] === undefined) {
        this.logger.error(`generateState undefined state`, pool);
        return;
      }
      pool.setState(states[index], blockNumber);
    });
    return this.state!;
  }

  async initPools(blockNumber: number): Promise<void> {
    this.setState({}, blockNumber);

    this.allPools = await this.fetchAllSubgraphPools();
    const eventSupportedPools = this.allPools.filter(
      pool =>
        this.eventSupportedPoolTypes.includes(pool.poolType) &&
        !this.eventRemovedPools.includes(pool.address.toLowerCase()),
    );

    const subgraphBasePools = eventSupportedPools.reduce<
      Record<string, SubgraphPoolBase>
    >((acc, subgraphInfo) => {
      acc[subgraphInfo.address.toLowerCase()] = subgraphInfo;
      return acc;
    }, {});
    const poolStates = await this.getOnChainState(
      eventSupportedPools,
      blockNumber,
    );
    this.poolsState = eventSupportedPools.reduce<
      Record<string, BalancerV2PoolState>
    >((acc, info, index) => {
      if (!this.isSupportedPool(info.poolType)) {
        return acc;
      }

      const poolAddress = info.address.toLowerCase();
      const _state = poolStates[index];

      const subgraphPool = subgraphBasePools[poolAddress];
      const pool = new BalancerV2PoolState(
        this.dexHelper,
        this.parentName,
        poolAddress,
        this.logger,
        subgraphPool,
        this.pools[subgraphPool.poolType],
      );
      pool.initialize(blockNumber);

      pool.setState(_state, blockNumber);
      this.allEventBasedPools[poolAddress] = pool;

      acc[poolAddress] = pool;
      return acc;
    }, {});

    this.initialize(blockNumber);
  }

  protected processLog(
    state: DeepReadonly<PoolStateMap>,
    log: Readonly<Log>,
  ): DeepReadonly<PoolStateMap> | null {
    try {
      const event = this.vaultDecoder(log);
      if (event.name in this.handlers) {
        const poolAddress = event.args.poolId.slice(0, 42).toLowerCase();
        // Only update the _state if we are tracking the pool
        if (poolAddress in this.poolsState) {
          this.handlers[event.name](
            event,
            this.poolsState[poolAddress],
            log.blockNumber,
          );
        }
      }
      return null;
    } catch (e) {
      this.logger.error(
        `Error_${this.parentName}_processLog could not parse the log with topic ${log.topics}:`,
        e,
      );
      return null;
    }
  }

  async fetchAllSubgraphPools(): Promise<SubgraphPoolBase[]> {
    const cacheKey = 'AllSubgraphPools';
    const cachedPools = await this.dexHelper.cache.get(
      this.parentName,
      this.dexHelper.network,
      cacheKey,
    );
    if (cachedPools) {
      const allEventBasedPools = JSON.parse(cachedPools);
      this.logger.info(
        `Got ${allEventBasedPools.length} ${this.parentName}_${this.dexHelper.network} pools from cache`,
      );
      return allEventBasedPools;
    }

    this.logger.info(
      `Fetching ${this.parentName}_${this.dexHelper.network} Pools from subgraph`,
    );
    const variables = {
      count: MAX_POOL_CNT,
    };
    const { data } = await this.dexHelper.httpRequest.post(
      this.subgraphURL,
      { query: fetchAllPools, variables },
      SUBGRAPH_TIMEOUT,
    );

    if (!(data && data.pools))
      throw new Error('Unable to fetch pools from the subgraph');

    this.dexHelper.cache.setex(
      this.parentName,
      this.dexHelper.network,
      cacheKey,
      POOL_CACHE_TTL,
      JSON.stringify(data.pools),
    );
    const allPools: SubgraphPoolBase[] = data.pools;
    allPools.forEach(p => (p.address = p.address.toLowerCase()));
    this.logger.info(
      `Got ${allPools.length} ${this.parentName}_${this.dexHelper.network} pools from subgraph`,
    );
    return allPools;
  }

  isSupportedPool(poolType: string): boolean {
    const supportedPoolTypes: string[] = Object.values(BalancerPoolTypes);
    return supportedPoolTypes.includes(poolType);
  }

  getPricesPool(
    from: Token,
    to: Token,
    pool: SubgraphPoolBase,
    poolState: PoolState,
    amounts: bigint[],
    unitVolume: bigint,
    side: SwapSide,
  ): { unit: bigint; prices: bigint[] } | null {
    if (!this.isSupportedPool(pool.poolType)) {
      console.error(`Unsupported Pool Type: ${pool.poolType}`);
      return null;
    }

    const _amounts = [unitVolume, ...amounts.slice(1)];

    const _pool = this.pools[pool.poolType];

    const poolPairData = _pool.parsePoolPairData(
      pool,
      poolState,
      from.address,
      to.address,
    );

    if (!_pool.checkBalance(amounts, unitVolume, side, poolPairData as any))
      return null;

    const _prices = this.pools[pool.poolType].onSell(
      _amounts,
      poolPairData as any,
    );
    return { unit: _prices[0], prices: [0n, ..._prices.slice(1)] };
  }

  async getOnChainState(
    subgraphPoolBase: SubgraphPoolBase[],
    blockNumber: number,
  ): Promise<PoolState[]> {
    const multiCallData = subgraphPoolBase
      .map(pool => {
        if (!this.isSupportedPool(pool.poolType)) return [];

        return this.pools[pool.poolType].getOnChainCalls(pool);
      })
      .flat();

    // 500 is an arbitrary number chosen based on the blockGasLimit
    const slicedMultiCallData = _.chunk(multiCallData, 500);

    const returnData = (
      await Promise.all(
        slicedMultiCallData.map(async _multiCallData =>
          this.dexHelper.multiContract.methods
            .tryAggregate(false, _multiCallData)
            .call({}, blockNumber),
        ),
      )
    ).flat();

    let i = 0;
    return subgraphPoolBase.map<PoolState>(pool => {
      const [decoded, newIndex] = this.pools[pool.poolType].decodeOnChainCalls(
        pool,
        returnData,
        i,
      );
      i = newIndex;
      return decoded;
    });
  }
}

type PoolToFetchResult = {
  eventBasedPools: SubgraphPoolBase[];
  nonEventBasedPools: SubgraphPoolBase[];
};

type PoolWithState = {
  info: SubgraphPoolBase;
  state: PoolState;
};

export class BalancerV2
  extends SimpleExchange
  implements IDex<BalancerV2Data, BalancerParam, OptimizedBalancerV2Data>
{
  protected eventPools: BalancerV2EventPool;

  readonly hasConstantPriceLargeAmounts = false;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(BalancerConfig);

  logger: Logger;

  // In memory pool state for non-event pools
  nonEventPoolStateCache: PoolStateCache;

  eventDisabledPoolsTimer?: NodeJS.Timer;
  eventDisabledPools = new Set<Address>();

  constructor(
    protected dexHelper: IDexHelper,
    dexKey: string,
    protected vaultAddress: Address = BalancerConfig[dexKey][dexHelper.network]
      .vaultAddress,
    protected subgraphURL: string = BalancerConfig[dexKey][dexHelper.network]
      .subgraphURL,
    protected adapters = Adapters[dexHelper.network],
  ) {
    super(dexHelper, dexKey);
    // Initialise cache - this will hold pool state of non-event pools in memory to be reused if block hasn't expired
    this.nonEventPoolStateCache = { blockNumber: 0, poolState: {} };
    this.logger = dexHelper.getLogger(`${dexKey}-${dexHelper.network}`);
    this.eventPools = new BalancerV2EventPool(
      dexHelper,
      dexKey,
      vaultAddress,
      subgraphURL,
      this.logger,
    );
  }

  async fetchEventDisabledPools() {
    const cacheKey = 'eventDisabledPools';
    const poolAddressListFromCache = await this.dexHelper.cache.get(
      this.dexKey,
      this.network,
      cacheKey,
    );
    if (poolAddressListFromCache) {
      this.eventDisabledPools = new Set(JSON.parse(poolAddressListFromCache));
      return;
    }
    this.logger.info(
      `Fetching ${this.dexKey}_${this.network} Weight Updates from subgraph`,
    );
    const timeNow = Math.floor(Date.now() / 1000);
    const variables = {
      count: MAX_POOL_CNT,
      timestampPast: timeNow - POOL_EVENT_REENABLE_DELAY,
      timestampFuture: timeNow + POOL_EVENT_DISABLED_TTL,
    };
    const { data } = await this.dexHelper.httpRequest.post(
      this.subgraphURL,
      { query: fetchWeightUpdating, variables },
      SUBGRAPH_TIMEOUT,
    );

    if (!(data && data.gradualWeightUpdates)) {
      throw new Error(
        `${this.dexKey}_${this.network} failed to fetch weight updates from subgraph`,
      );
    }

    this.eventDisabledPools = data.gradualWeightUpdates.reduce(
      (acc: Set<Address>, pool: { poolId: { address: Address } }) => {
        acc.add(pool.poolId.address.toLowerCase());
        return acc;
      },
      new Set<Address>(),
    );

    const poolAddressList = JSON.stringify(Array.from(this.eventDisabledPools));
    this.logger.info(
      `Pools blocked from event based on ${this.dexKey}_${this.network}: ${poolAddressList}`,
    );
    this.dexHelper.cache.setex(
      this.dexKey,
      this.network,
      cacheKey,
      POOL_EVENT_DISABLED_TTL,
      poolAddressList,
    );
  }

  releaseResources(): void {
    if (this.eventDisabledPoolsTimer) {
      clearInterval(this.eventDisabledPoolsTimer);
      this.eventDisabledPoolsTimer = undefined;
      this.logger.info(
        `${this.dexKey}: cleared eventDisabledPoolsTimer before shutting down`,
      );
    }
  }
  async initializePricing(blockNumber: number) {
    if (!this.eventDisabledPoolsTimer) {
      await this.fetchEventDisabledPools();
      this.eventDisabledPoolsTimer = setInterval(async () => {
        try {
          await this.fetchEventDisabledPools();
        } catch (e) {
          this.logger.error(
            `${this.dexKey}: Failed to update event disabled pools:`,
            e,
          );
        }
      }, POOL_EVENT_DISABLED_TTL * 1000);
    }
    await this.eventPools.initPools(blockNumber);
  }

  getPools(from: Token, to: Token): SubgraphPoolBase[] {
    return this.eventPools.allPools
      .filter(
        p =>
          p.tokens.some(
            token => token.address.toLowerCase() === from.address.toLowerCase(),
          ) &&
          p.tokens.some(
            token => token.address.toLowerCase() === to.address.toLowerCase(),
          ),
      )
      .slice(0, 10);
  }

  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    if (side === SwapSide.BUY) return null;
    return this.adapters;
  }

  async getPoolIdentifiers(
    from: Token,
    to: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    if (side === SwapSide.BUY) return [];

    const _from = this.dexHelper.config.wrapETH(from);
    const _to = this.dexHelper.config.wrapETH(to);

    const pools = this.getPools(_from, _to);

    return pools.map(pool => `${this.dexKey}_${pool.address.toLowerCase()}`);
  }

  /**
   * Returns cached poolState if blockNumber matches cached value. Resets if not.
   */
  private getNonEventPoolStateCache(blockNumber: number): PoolStateMap {
    if (this.nonEventPoolStateCache.blockNumber !== blockNumber)
      this.nonEventPoolStateCache.poolState = {};
    return this.nonEventPoolStateCache.poolState;
  }

  /**
   * Update poolState cache.
   * If same blockNumber as current cache then update with new pool state.
   * If different blockNumber overwrite cache with latest.
   */
  private updateNonEventPoolStateCache(
    poolState: PoolStateMap,
    blockNumber: number,
  ): PoolStateMap {
    if (this.nonEventPoolStateCache.blockNumber !== blockNumber) {
      this.nonEventPoolStateCache.blockNumber = blockNumber;
      this.nonEventPoolStateCache.poolState = poolState;
    } else
      this.nonEventPoolStateCache.poolState = {
        ...this.nonEventPoolStateCache.poolState,
        ...poolState,
      };
    return this.nonEventPoolStateCache.poolState;
  }

  async getPricesVolume(
    from: Token,
    to: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<BalancerV2Data>> {
    if (side === SwapSide.BUY) return null;
    try {
      const _from = this.dexHelper.config.wrapETH(from);
      const _to = this.dexHelper.config.wrapETH(to);

      const allPools = this.getPools(_from, _to);
      const allowedPools = limitPools
        ? allPools.filter(({ address }) =>
            limitPools.includes(`${this.dexKey}_${address.toLowerCase()}`),
          )
        : allPools;

      if (!allowedPools.length) return null;

      const unitVolume = getBigIntPow(
        (side === SwapSide.SELL ? _from : _to).decimals,
      );

      const pools = allowedPools.reduce<PoolToFetchResult>(
        (acc, pool) => {
          if (this.eventDisabledPools.has(pool.address.toLowerCase())) {
            acc.nonEventBasedPools.push(pool);
          } else {
            acc.eventBasedPools.push(pool);
          }
          return acc;
        },
        {
          eventBasedPools: [],
          nonEventBasedPools: [],
        },
      );

      const eventBasedP = pools.eventBasedPools.reduce(async (accP, pool) => {
        const acc = await accP;
        const eventPool = this.eventPools.allEventBasedPools[pool.address];
        if (!eventPool) {
          this.logger.warn(`missing pool ${pool.address}`);
          return acc;
        }
        let state = eventPool.getState(blockNumber);
        if (!state) {
          state = await eventPool.generateState(blockNumber);
          if (state) {
            eventPool.setState(state, blockNumber);
          } else {
            this.logger.error(
              `failed to generateState for pool ${pool.address}`,
            );
            return acc;
          }
        }
        acc.push({
          info: pool,
          state,
        });

        return acc;
      }, Promise.resolve([] as PoolWithState[]));

      let nonEventPoolStates = this.getNonEventPoolStateCache(blockNumber);

      const notEventBasedPools = pools.nonEventBasedPools.reduce(
        (acc, p) => {
          if (p.address in nonEventPoolStates) {
            acc.poolsWithState.push({
              info: p,
              state: nonEventPoolStates[p.address],
            });
          } else {
            acc.toFetch.push(p);
          }

          return acc;
        },
        {
          toFetch: [] as SubgraphPoolBase[],
          poolsWithState: [] as PoolWithState[],
        },
      );
      const nonEventBasedStatesP = this.eventPools.getOnChainState(
        notEventBasedPools.toFetch,
        blockNumber,
      );

      const [eventBased, nonEventBasedState] = await Promise.all([
        eventBasedP,
        nonEventBasedStatesP,
      ]);

      const nonEventBasedPoolsWithState = nonEventBasedState.map<PoolWithState>(
        (state, index) => {
          const info = notEventBasedPools.toFetch[index];
          if (!info) {
            this.logger.error(`did not find in all pools`);
          }

          return {
            info,
            state,
          };
        },
      );

      if (nonEventBasedPoolsWithState.length !== 0) {
        const statesMap = nonEventBasedPoolsWithState.reduce((acc, pool) => {
          acc[pool.info.address] = pool.state;
          return acc;
        }, {} as PoolStateMap);
        this.updateNonEventPoolStateCache(statesMap, blockNumber);
      }

      const poolsStates = [
        ...eventBased,
        ...notEventBasedPools.poolsWithState,
        ...nonEventBasedPoolsWithState,
      ];

      const poolPrices = poolsStates.map(pool => {
        // TODO: re-check what should be the current block time stamp
        const poolAddress = pool.info.address;
        try {
          const res = this.eventPools.getPricesPool(
            _from,
            _to,
            pool.info,
            pool.state,
            amounts,
            unitVolume,
            side,
          );
          if (!res) return;
          return {
            unit: res.unit,
            prices: res.prices,
            data: {
              poolId: pool.info.id,
            },
            poolAddresses: [poolAddress],
            exchange: this.dexKey,
            gasCost: 150 * 1000,
            poolIdentifier: `${this.dexKey}_${poolAddress}`,
          };
        } catch (e) {
          this.logger.error(
            `Error_getPrices ${from.symbol || from.address}, ${
              to.symbol || to.address
            }, ${side}, ${poolAddress}:`,
            e,
          );
          return null;
        }
      });

      return poolPrices.filter(p => !!p) as ExchangePrices<BalancerV2Data>;
    } catch (e) {
      this.logger.error(
        `Error_getPrices ${from.symbol || from.address}, ${
          to.symbol || to.address
        }, ${side}:`,
        e,
      );
      return null;
    }
  }

  // Returns estimated gas cost of calldata for this DEX in multiSwap
  getCalldataGasCost(
    poolPrices: PoolPrices<BalancerV2Data>,
  ): number | number[] {
    return (
      CALLDATA_GAS_COST.DEX_OVERHEAD +
      CALLDATA_GAS_COST.LENGTH_LARGE +
      // ParentStruct header
      CALLDATA_GAS_COST.OFFSET_SMALL +
      // ParentStruct -> swaps[] header
      CALLDATA_GAS_COST.OFFSET_LARGE +
      // ParentStruct -> assets[] header
      CALLDATA_GAS_COST.OFFSET_LARGE +
      // ParentStruct -> funds
      CALLDATA_GAS_COST.ADDRESS +
      CALLDATA_GAS_COST.BOOL +
      CALLDATA_GAS_COST.ADDRESS +
      CALLDATA_GAS_COST.BOOL +
      // ParentStruct -> limits[] header
      CALLDATA_GAS_COST.OFFSET_LARGE +
      // ParentStruct -> deadline
      CALLDATA_GAS_COST.TIMESTAMP +
      // ParentStruct -> swaps[]
      CALLDATA_GAS_COST.LENGTH_SMALL +
      // ParentStruct -> swaps[0] header
      CALLDATA_GAS_COST.OFFSET_SMALL +
      // ParentStruct -> swaps[0] -> poolId
      CALLDATA_GAS_COST.FULL_WORD +
      // ParentStruct -> swaps[0] -> assetInIndex
      CALLDATA_GAS_COST.INDEX +
      // ParentStruct -> swaps[0] -> assetOutIndex
      CALLDATA_GAS_COST.INDEX +
      // ParentStruct -> swaps[0] -> amount
      CALLDATA_GAS_COST.AMOUNT +
      // ParentStruct -> swaps[0] -> userData header
      CALLDATA_GAS_COST.OFFSET_SMALL +
      // ParentStruct -> swaps[0] -> userData
      CALLDATA_GAS_COST.ZERO +
      // ParentStruct -> assets[]
      CALLDATA_GAS_COST.LENGTH_SMALL +
      // ParentStruct -> assets[0:2]
      CALLDATA_GAS_COST.ADDRESS * 2 +
      // ParentStruct -> limits[]
      CALLDATA_GAS_COST.LENGTH_SMALL +
      // ParentStruct -> limits[0:2]
      CALLDATA_GAS_COST.FULL_WORD * 2
    );
  }

  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: OptimizedBalancerV2Data,
    side: SwapSide,
  ): AdapterExchangeParam {
    const params = this.getBalancerParam(
      srcToken,
      destToken,
      srcAmount,
      destAmount,
      data,
      side,
    );

    const payload = this.abiCoder.encodeParameter(
      {
        ParentStruct: {
          'swaps[]': {
            poolId: 'bytes32',
            assetInIndex: 'uint256',
            assetOutIndex: 'uint256',
            amount: 'uint256',
            userData: 'bytes',
          },
          assets: 'address[]',
          funds: {
            sender: 'address',
            fromInternalBalance: 'bool',
            recipient: 'address',
            toInternalBalance: 'bool',
          },
          limits: 'int256[]',
          deadline: 'uint256',
        },
      },
      {
        swaps: params[1],
        assets: params[2],
        funds: params[3],
        limits: params[4],
        deadline: params[5],
      },
    );

    return {
      targetExchange: this.vaultAddress,
      payload,
      networkFee: '0',
    };
  }

  private getBalancerParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: OptimizedBalancerV2Data,
    side: SwapSide,
  ): BalancerParam {
    // BalancerV2 Uses Address(0) as ETH
    const assets = [srcToken, destToken].map(t =>
      t.toLowerCase() === ETHER_ADDRESS.toLowerCase() ? NULL_ADDRESS : t,
    );

    const swaps = data.swaps.map(s => ({
      poolId: s.poolId,
      assetInIndex: 0,
      assetOutIndex: 1,
      amount: s.amount,
      userData: '0x',
    }));

    const funds = {
      sender: this.augustusAddress,
      recipient: this.augustusAddress,
      fromInternalBalance: false,
      toInternalBalance: false,
    };

    const limits = [MAX_INT, MAX_INT];

    const params: BalancerParam = [
      side === SwapSide.SELL ? SwapTypes.SwapExactIn : SwapTypes.SwapExactOut,
      swaps,
      assets,
      funds,
      limits,
      MAX_UINT,
    ];

    return params;
  }

  async getSimpleParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: OptimizedBalancerV2Data,
    side: SwapSide,
  ): Promise<SimpleExchangeParam> {
    const params = this.getBalancerParam(
      srcToken,
      destToken,
      srcAmount,
      destAmount,
      data,
      side,
    );

    const swapData = this.eventPools.vaultInterface.encodeFunctionData(
      'batchSwap',
      params,
    );

    return this.buildSimpleParamWithoutWETHConversion(
      srcToken,
      srcAmount,
      destToken,
      destAmount,
      swapData,
      this.vaultAddress,
    );
  }

  async getTopPoolsForToken(
    tokenAddress: Address,
    count: number,
  ): Promise<PoolLiquidity[]> {
    const variables = {
      tokens: [tokenAddress],
      count,
    };

    const query = `query ($tokens: [Bytes!], $count: Int) {
      pools (first: $count, orderBy: totalLiquidity, orderDirection: desc,
           where: {tokensList_contains: $tokens,
                   swapEnabled: true,
                   totalLiquidity_gt: 0}) {
        address
        totalLiquidity
        tokens {
          address
          decimals
        }
      }
    }`;
    const { data } = await this.dexHelper.httpRequest.post(
      this.subgraphURL,
      {
        query,
        variables,
      },
      SUBGRAPH_TIMEOUT,
    );

    if (!(data && data.pools))
      throw new Error(
        `Error_${this.dexKey}_Subgraph: couldn't fetch the pools from the subgraph`,
      );

    const pools = _.map(data.pools, (pool: any) => ({
      exchange: this.dexKey,
      address: pool.address.toLowerCase(),
      connectorTokens: pool.tokens.reduce(
        (
          acc: Token[],
          { decimals, address }: { decimals: number; address: string },
        ) => {
          if (address.toLowerCase() != tokenAddress.toLowerCase())
            acc.push({ decimals, address: address.toLowerCase() });
          return acc;
        },
        [],
      ),
      liquidityUSD: parseFloat(pool.totalLiquidity),
    }));

    return pools;
  }
}
