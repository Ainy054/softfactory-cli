import { Task } from './types.js';
import { IWorker } from './IWorker.js';
import { AgyWorker } from './AgyWorker.js';
import { CodexWorker } from './CodexWorker.js';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import { createChatTransport } from './ChatTransport.js';
import { CliAgentWorker, type CliAgentDefinition } from './CliAgentWorker.js';

export type WorkerStrategy = 'hybrid' | 'local' | 'cloud';
export type CloudProvider = 'agy' | 'openai' | 'openai-api' | 'anthropic' | 'deepseek' | 'qwen' | 'openai-compat' | 'claude-code' | 'gemini-cli' | 'muse';
export const CLOUD_PROVIDERS: CloudProvider[] = ['agy', 'openai', 'openai-api', 'anthropic', 'deepseek', 'qwen', 'openai-compat', 'claude-code', 'gemini-cli', 'muse'];
/** Providers whose workers are the tool loop over an API transport. */
export const API_PROVIDERS: CloudProvider[] = ['openai-api', 'anthropic', 'deepseek', 'qwen', 'openai-compat'];
/** Providers that are whole coding agents with their own loop and permission rules. */
export const AGENT_PROVIDERS: CloudProvider[] = ['claude-code', 'gemini-cli', 'muse'];

export class WorkerRegistry {
  private localWorker: IWorker;
  private cloudWorker: IWorker;
  private cloudProvider: CloudProvider;
  private strategy: WorkerStrategy;
  private localModel: string;
  private cloudModel: string;
  private frontierModel: string;
  private lightLocalModel: string;
  private heavyLocalModel: string;

  constructor(
    strategy: WorkerStrategy = 'hybrid',
    localModel: string = 'auto',
    cloudModel: string = 'Gemini 3.7 Flash (High)',
    frontierModel: string = 'Gemini 3.1 Pro (High)',
    lightLocalModel: string = 'qwen2.5-coder:7b',
    heavyLocalModel: string = 'qwen2.5-coder:14b',
    cloudProvider: CloudProvider = 'agy'
  ) {
    this.strategy = strategy;
    this.localModel = localModel;
    this.cloudModel = cloudModel;
    this.frontierModel = frontierModel;
    this.lightLocalModel = lightLocalModel;
    this.heavyLocalModel = heavyLocalModel;
    this.cloudProvider = cloudProvider;
    // Every model-API backend runs the same tool loop; only the transport differs.
    this.localWorker = new ToolLoopWorker(createChatTransport('local'), localModel === 'auto' ? lightLocalModel : localModel);
    this.cloudWorker = cloudProvider === 'agy' ? new AgyWorker(cloudModel)
      : cloudProvider === 'openai' ? new CodexWorker(cloudModel)
      : cloudProvider === 'claude-code' || cloudProvider === 'gemini-cli' || cloudProvider === 'muse' ? new CliAgentWorker(cloudProvider, cloudModel)
      : cloudProvider === 'deepseek' ? new ToolLoopWorker(createChatTransport('deepseek'), cloudModel || 'deepseek-v4-flash')
      : new ToolLoopWorker(createChatTransport(cloudProvider), cloudModel);
  }

  /**
   * Size, not job title. Routing on agent_role sent a six-file devops task that
   * had to author a new config to the smallest model, repeatedly.
   */
  isLightTask(task: Task): boolean {
    // Protected code never goes to the smallest model, whatever its shape.
    if (task.protected) return false;
    const touched = new Set([...(task.files_hint || []), ...(task.creates_files || [])]);
    if (touched.size > 2) return false;
    if ((task.description?.length || 0) > 600) return false;
    if ((task.acceptance_criteria?.length || 0) > 3) return false;
    return touched.size <= 1 && (task.phase || 1) <= 2;
  }

  /** Tasks that are too broad or ambiguous for a first-pass small local model. */
  shouldPreferCloud(task: Task): boolean {
    if (task.protected) return true;
    const files = new Set([...(task.files_hint || []), ...(task.creates_files || [])]);
    return files.size > 2 || (task.acceptance_criteria?.length || 0) > 3 ||
      (task.agent_role === 'test_writer' && files.size > 1) ||
      task.agent_role === 'architect' || task.agent_role === 'builder';
  }

  getCloudProvider(): CloudProvider {
    return this.cloudProvider;
  }

  /** Set when the cloud worker is an external coding agent that runs its own commands. */
  agentDefinition(): CliAgentDefinition | undefined {
    return this.cloudWorker instanceof CliAgentWorker ? this.cloudWorker.definition : undefined;
  }

  /** Check configured backends once before a run starts. */
  async preflight(): Promise<{ local: boolean; cloud: boolean; localModel: string; cloudModel: string }> {
    const localModel = this.localModel === 'auto' || this.localModel === 'tiered'
      ? this.heavyLocalModel : this.localModel;
    const local = this.strategy === 'cloud' ? false : await this.localWorker.isAvailable(localModel);
    const cloudModel = this.cloudModel;
    const cloud = this.strategy === 'local' ? false : await this.cloudWorker.isAvailable(cloudModel);
    return { local, cloud, localModel, cloudModel };
  }

  resolveLocalModel(task: Task, isRetry: boolean): string {
    // If user explicitly provided a specific custom model (e.g. deepseek, qwen:3b, llama), honor it
    if (this.localModel !== 'auto' && this.localModel !== 'tiered' && this.localModel !== this.lightLocalModel && this.localModel !== this.heavyLocalModel) {
      return this.localModel;
    }

    // On retries, and for protected code, always the heavy local model (14B)
    if (isRetry || task.protected) {
      return this.heavyLocalModel;
    }

    // On first attempt: light tasks get 7B (fast), heavy tasks get 14B (deep reasoning)
    return this.isLightTask(task) ? this.lightLocalModel : this.heavyLocalModel;
  }

  async resolveWorker(task: Task): Promise<{ worker: IWorker; model: string; provider: string; escalated?: boolean }> {
    // Prefer the explicit escalation tier, while honoring older persisted
    // states that only recorded attempts as their escalation signal.
    const escalation = Math.max(task.escalation_level || 0, task.attempts || 0);

    // 1. Cloud-only Strategy:
    if (this.strategy === 'cloud') {
      const model = escalation >= 2 ? this.frontierModel : this.cloudModel;
      return { worker: this.cloudWorker, model, provider: this.cloudProvider, escalated: escalation >= 2 };
    }

    // 2. Local-only Strategy (Strictly 100% Offline with 7B/14B Local Tiering):
    if (this.strategy === 'local') {
      const model = escalation > 0 ? this.heavyLocalModel : this.resolveLocalModel(task, false);
      return {
        worker: this.localWorker, provider: 'ollama',
        model,
        escalated: escalation > 0 && model === this.heavyLocalModel,
      };
    }

    // 3. Hybrid Strategy (Local Tiered + Cloud Escalation Ladder):
    if (task.agent_role === 'architect' || task.worker_type === 'cloud') {
      const model = escalation >= 2 ? this.frontierModel : this.cloudModel;
      return { worker: this.cloudWorker, model, provider: this.cloudProvider, escalated: escalation >= 2 };
    }

    // Avoid spending a local retry budget on work that exceeds the small-model
    // envelope. Hybrid mode still prefers Qwen for bounded tasks.
    if (escalation === 0 && this.shouldPreferCloud(task)) {
      const cloudAvailable = await this.cloudWorker.isAvailable();
      if (cloudAvailable) return { worker: this.cloudWorker, model: this.cloudModel, provider: this.cloudProvider, escalated: true };
    }

    // Escalation 0: Local Fast Model (7B for light tasks, 14B for heavy coding tasks)
    if (escalation === 0) {
      const localModel = this.resolveLocalModel(task, false);
      const localAvailable = await this.localWorker.isAvailable(localModel);
      if (localAvailable) {
        return { worker: this.localWorker, model: localModel, provider: 'ollama' };
      }
      return { worker: this.cloudWorker, model: this.cloudModel, provider: this.cloudProvider };
    }

    // Escalation 1: Escalate to Heavy Local Model (14B)
    if (escalation === 1) {
      const localAvailable = await this.localWorker.isAvailable(this.heavyLocalModel);
      if (localAvailable) {
        return { worker: this.localWorker, model: this.heavyLocalModel, provider: 'ollama', escalated: true };
      }
      return { worker: this.cloudWorker, model: this.cloudModel, provider: this.cloudProvider, escalated: true };
    }

    // Escalation 2: Escalate to Fast Cloud Model (Gemini 3.7 Flash)
    if (escalation === 2) {
      const cloudAvailable = await this.cloudWorker.isAvailable();
      if (cloudAvailable) {
        return { worker: this.cloudWorker, model: this.cloudModel, provider: this.cloudProvider, escalated: true };
      }
      return { worker: this.localWorker, model: this.heavyLocalModel, provider: 'ollama', escalated: true };
    }

    // Escalation 3+: Escalate to Frontier Cloud Model (Gemini 3.1 Pro)
    const cloudAvailable = await this.cloudWorker.isAvailable();
    if (cloudAvailable) {
      return { worker: this.cloudWorker, model: this.frontierModel, provider: this.cloudProvider, escalated: true };
    }
    return { worker: this.localWorker, model: this.heavyLocalModel, provider: 'ollama', escalated: true };
  }
}
