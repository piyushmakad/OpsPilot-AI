import { BgeSmallEmbeddings } from './embedding.js';
import { KnowledgeSearch } from './retrieval.js';
import { RunRepository } from './repository.js';
import { WorkflowEngine } from './workflow-engine.js';
import { DemoWorkflowModel, HostedWorkflowModel } from './workflow-model.js';
import { WorkflowStore } from './workflow-store.js';
import { LocalCapabilityClient } from './workflow-tools.js';
import { ContextService } from './context-service.js';

export function createWorkflowRuntime(runs: RunRepository, demo: boolean) {
  const store = new WorkflowStore(runs);
  const knowledge = KnowledgeSearch.fromEnvironment(new BgeSmallEmbeddings());
  const capabilities = new LocalCapabilityClient(store, knowledge);
  const model = demo ? new DemoWorkflowModel() : new HostedWorkflowModel();
  const engine = new WorkflowEngine(runs, store, model, capabilities, undefined, undefined,
    new ContextService(runs.pool));
  return { store, knowledge, engine };
}
