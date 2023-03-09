import { Config } from '#self/config';
import { WorkerStatus } from '#self/lib/constants';
import { FunctionProfileManager } from '#self/lib/function_profile';
import { RawFunctionProfile } from '#self/lib/json/function_profile';
import { PrefixedLogger } from '#self/lib/loggers';
import { Worker, WorkerMetadata, WorkerStats } from './worker';

interface StartingPoolItem {
  credential: string;
  estimateRequestLeft?: number;
  maxActivateRequests?: number;
}

class Broker {
  redundantTimes: number;

  private config: Config;

  private profiles: FunctionProfileManager;

  name: string;

  private logger: PrefixedLogger;

  isInspector: boolean;

  data: RawFunctionProfile | null;

  workers: Map<string, Worker>;

  startingPool: Map<string, StartingPoolItem>;

  /**
   * Constructor
   * @param profiles The profile manager.
   * @param config The global config object.
   * @param funcName The function name of this broker.
   * @param isInspector Whether it's using inspector or not.
   */
  constructor(
    profiles: FunctionProfileManager,
    config: Config,
    funcName: string,
    isInspector: boolean,
    public disposable: boolean = false
  ) {
    this.config = config;
    this.logger = new PrefixedLogger(
      'worker_stats_snapshot broker',
      Broker.getKey(funcName, isInspector)
    );

    this.name = funcName;
    this.profiles = profiles;
    this.isInspector = !!isInspector;
    this.data = profiles?.get(funcName)?.toJSON(true) || null;

    this.workers = new Map();
    this.startingPool = new Map();

    this.redundantTimes = 0;
  }

  /**
   * The reservation count of this broker.
   * @return {number} The reservation count.
   */
  get reservationCount() {
    if (this.isInspector) {
      return 1;
    }

    if (this.disposable) {
      return 0;
    }

    return this.data?.worker?.reservationCount || 0;
  }

  get initializationTimeout() {
    return (
      this.data?.worker?.initializationTimeout ||
      this.config.worker.defaultInitializerTimeout
    );
  }

  /**
   * Register worker.
   * @param processName The process name (worker name).
   * @param credential The credential.
   */
  register(workerMetadata: WorkerMetadata): Worker {
    if (!this.data) {
      throw new Error(`No function profile named ${this.name}.`);
    }
    const worker = new Worker(
      workerMetadata,
      this.config,
      this.initializationTimeout
    );

    this.workers.set(workerMetadata.processName!, worker);

    this.startingPool.set(workerMetadata.processName!, {
      credential: workerMetadata.credential!,
      estimateRequestLeft: this.data.worker?.maxActivateRequests,
      maxActivateRequests: this.data.worker?.maxActivateRequests,
    });

    return worker;
  }

  /**
   * Remove item from starting pool.
   * @param {string} processName The process name (worker name).
   */
  removeItemFromStartingPool(processName: string) {
    this.startingPool.delete(processName);
  }

  /**
   * Pre-request the starting pool.
   * @return {boolean} Returns true if there's still at least one idle starting worker.
   */
  prerequestStartingPool() {
    for (const value of this.startingPool.values()) {
      if (value.estimateRequestLeft) {
        value.estimateRequestLeft--;
        return true;
      }
    }
    return false;
  }

  /**
   * @type {number}
   */
  get virtualMemory() {
    return this.workerCount * this.memoryLimit;
  }

  /**
   * @type {number}
   */
  get memoryLimit() {
    return this.data?.resourceLimit?.memory || 0;
  }

  /**
   * Sync from data plane.
   * @param workers The workers.
   */
  sync(workers: WorkerStats[]) {
    this.data = this.profiles.get(this.name)?.toJSON(true) || null;

    const newMap: Map<string, Worker> = new Map();
    for (const item of workers) {
      const name = item.name;
      if (name == null) {
        continue;
      }
      const worker = this.workers.get(name);
      if (!worker) {
        // 一切以 Control Plane 已存在数据为准
        continue;
      }

      worker.sync(item);
      newMap.set(name, worker);
      this.workers.delete(name);
    }

    for (const item of this.workers.values()) {
      item.sync(null);
      newMap.set(item.name, item);
    }

    // 将已启动完成、失败的从 `startingPool` 中移除
    for (const startingName of this.startingPool.keys()) {
      const worker = newMap.get(startingName)!;
      if (!worker.isInitializating()) {
        this.logger.debug(
          '%s removed from starting pool due to status ' + '[%s] - [%s]',
          startingName,
          WorkerStatus[worker.workerStatus],
          worker.turfContainerStates
        );
        this.startingPool.delete(startingName);
      } else if (worker.data) {
        // 同步 startingPool 中的值
        const item = this.startingPool.get(startingName)!;

        item.maxActivateRequests = worker.data.maxActivateRequests!;
        item.estimateRequestLeft =
          worker.data.maxActivateRequests! - worker.data.activeRequestCount!;
      }
    }

    this.workers = newMap;
  }

  /**
   * @type {number}
   */
  get workerCount() {
    let value = 0;
    for (const worker of this.workers.values()) {
      if (worker.isRunning()) {
        value++;
      }
    }

    // startingPool 中都是正在启动的，没有 ready，没有执行 initialize handler
    return value;
  }

  /**
   * @type {number}
   */
  get totalMaxActivateRequests() {
    let m = 0;
    for (const worker of this.workers.values()) {
      if (!worker.isRunning()) continue;
      m += worker.data?.maxActivateRequests! || 0;
    }

    // 不计算 startingPool 中的值

    return m;
  }

  /**
   * @type {number}
   */
  get activeRequestCount() {
    let a = 0;
    for (const worker of this.workers.values()) {
      if (!worker.isRunning()) continue;
      a += worker.data?.activeRequestCount || 0;
    }

    // 不考虑 starting pool 里面的值

    return a;
  }

  /**
   * @type {number}
   */
  get waterLevel() {
    return this.activeRequestCount / this.totalMaxActivateRequests;
  }

  /**
   * Get worker.
   * @param processName The process name (worker name).
   * @return The matched worker object.
   */
  getWorker(processName: string) {
    return this.workers.get(processName) || null;
  }

  /**
   * Get the map key by function name and `isInspector`.
   * @param functionName The function name.
   * @param isInspector Whether it's using inspector or not.
   * @return The map key.
   */
  static getKey(functionName: string, isInspector: boolean) {
    return `${functionName}:${isInspector ? 'inspector' : 'noinspector'}`;
  }

  toJSON() {
    return {
      name: this.name,
      inspector: this.isInspector,
      profile: this.data,
      redundantTimes: this.redundantTimes,
      startingPool: [...this.startingPool.entries()].map(([key, value]) => ({
        workerName: key,
        credential: value.credential,
        estimateRequestLeft: value.estimateRequestLeft,
        maxActivateRequests: value.maxActivateRequests,
      })),
      workers: Array.from(this.workers.values()).map(worker => worker.toJSON()),
    };
  }
}

export { Broker };
