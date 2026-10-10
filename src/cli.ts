import { AgentEngine } from './engine.js';
import { DemoModel, HostedModel } from './model.js';
import { RunRepository } from './repository.js';

const [command, ...args] = process.argv.slice(2);
const repository = RunRepository.fromEnvironment();

try {
  if (command === 'migrate') {
    await repository.migrate();
    console.log('Migration applied');
  } else if (command === 'start') {
    const demo = args[0] === '--demo';
    const request = (demo ? args.slice(1) : args).join(' ');
    const model = demo ? new DemoModel() : new HostedModel();
    const run = await repository.create(request);
    console.log(`Created run ${run.id}`);
    await new AgentEngine(repository, model).execute(run.id);
    console.log(JSON.stringify(await repository.get(run.id), null, 2));
  } else if (command === 'resume' && args[0]) {
    const demo = args.includes('--demo');
    await new AgentEngine(repository, demo ? new DemoModel() : new HostedModel()).execute(args[0]);
    console.log(JSON.stringify(await repository.get(args[0]), null, 2));
  } else if (command === 'show' && args[0]) {
    console.log(JSON.stringify({ run: await repository.get(args[0]), events: await repository.events(args[0]) }, null, 2));
  } else {
    throw new Error('Usage: migrate | start [--demo] "request" | resume <run-id> [--demo] | show <run-id>');
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await repository.close();
}
