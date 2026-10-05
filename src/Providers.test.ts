import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { modelListed, compatEndpoint, createTextModel, DeepSeekTextModel, OpenAiCompatibleTextModel } from './TextModel.js';
import { createChatTransport } from './ChatTransport.js';
import { WorkerRegistry } from './WorkerRegistry.js';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import { Factory } from './Factory.js';
import { parseDotEnv, loadDotEnv } from './dotenv.js';

function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T> | T): Promise<T> | T {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { previous[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try {
    const result = run();
    return result instanceof Promise ? result.finally(restore) : (restore(), result);
  } catch (error) { restore(); throw error; }
}

const json = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('a model listing is advisory', () => {
  it('matches the served alias DeepSeek lists under another name, and never blocks on an empty listing', () => {
    assert.equal(modelListed('deepseek-v4-flash', ['deepseek-flash', 'deepseek-v4-pro']), true, 'the live account lists deepseek-flash and serves deepseek-v4-flash');
    assert.equal(modelListed('deepseek-v4-pro', ['deepseek-flash', 'deepseek-v4-pro']), true);
    assert.equal(modelListed('deepseek-v9-ultra', ['deepseek-flash', 'deepseek-v4-pro']), false);
    assert.equal(modelListed('qwen3-coder-plus', ['qwen3-coder-plus', 'qwen-max']), true);
    assert.equal(modelListed('anything', []), true);
    assert.equal(modelListed('', ['x']), true);
  });

  it('is applied by the DeepSeek text model and the OpenAI-compatible transport', async () => {
    await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
      const listing = json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });
      assert.equal(await new DeepSeekTextModel('deepseek-v4-flash', listing).isAvailable(), true);
      const transport = createChatTransport('deepseek', { fetchImpl: listing });
      assert.deepEqual(await transport.checkAvailability('deepseek-v4-flash'), { reachable: true, modelPresent: true, installed: ['deepseek-flash', 'deepseek-v4-pro'] });
    });
  });
});

describe('Qwen on DashScope and a generic OpenAI-compatible endpoint', () => {
  it('points Qwen at the international compatible-mode endpoint unless told otherwise', () => {
    withEnv({ DASHSCOPE_BASE_URL: undefined }, () => {
      const endpoint = compatEndpoint('qwen');
      assert.equal(endpoint.baseUrl, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
      assert.equal(endpoint.apiKeyEnv, 'DASHSCOPE_API_KEY');
    });
    withEnv({ DASHSCOPE_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/' }, () => {
      assert.equal(compatEndpoint('qwen').baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'trailing slash dropped');
    });
  });

  it('builds the transport and text model from the endpoint, with the key from the environment', async () => {
    await withEnv({ DASHSCOPE_API_KEY: 'qk', DASHSCOPE_BASE_URL: undefined }, async () => {
      const bodies: any[] = []; const urls: string[] = [];
      const fetchImpl = (async (url: any, init?: any) => { urls.push(String(url)); bodies.push(init?.body ? JSON.parse(init.body) : null); return new Response(JSON.stringify(url.toString().endsWith('/models') ? { data: [{ id: 'qwen3-coder-plus' }] } : { choices: [{ message: { content: 'hi' } }] }), { status: 200 }); }) as typeof fetch;
      const transport = createChatTransport('qwen', { fetchImpl });
      assert.equal(transport.id, 'qwen-cloud');
      assert.equal(transport.label, 'Qwen');
      assert.deepEqual(await transport.checkAvailability('qwen3-coder-plus'), { reachable: true, modelPresent: true, installed: ['qwen3-coder-plus'] });
      assert.equal(urls[0], 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models');
      const text = createTextModel('qwen', 'qwen3-coder-plus', { fetchImpl });
      assert.equal(text.provider, 'qwen');
      assert.equal(await text.complete('p'), 'hi');
      assert.equal(urls[1], 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
      assert.equal(bodies[1].model, 'qwen3-coder-plus');
      assert.equal('response_format' in bodies[1], false, 'compatible endpoints do not all accept response_format');
    });
  });

  it('refuses the generic endpoint without a base URL, and names the variable', async () => {
    await withEnv({ SOFTFACTORY_COMPAT_BASE_URL: undefined, SOFTFACTORY_COMPAT_API_KEY: 'k' }, async () => {
      const transport = createChatTransport('openai-compat');
      assert.match(transport.unreachable(), /SOFTFACTORY_COMPAT_BASE_URL/);
      await assert.rejects(() => new OpenAiCompatibleTextModel('m', compatEndpoint('openai-compat')).complete('p'), /no base URL configured/);
    });
    await withEnv({ SOFTFACTORY_COMPAT_BASE_URL: 'https://api.moonshot.ai/v1', SOFTFACTORY_COMPAT_API_KEY: 'k', SOFTFACTORY_COMPAT_LABEL: 'Kimi' }, async () => {
      const transport = createChatTransport('openai-compat', { fetchImpl: json({ data: [] }) });
      assert.equal(transport.label, 'Kimi');
      assert.deepEqual(await transport.checkAvailability('kimi-k2.7-code-highspeed'), { reachable: true, modelPresent: true, installed: [] });
    });
  });

  it('are providers like any other: worker, inspector and planner', () => {
    withEnv({ SOFTFACTORY_COMPAT_BASE_URL: 'https://x/v1' }, () => {
      for (const provider of ['qwen', 'openai-compat'] as const) {
        const registry: any = new WorkerRegistry('cloud', 'auto', 'm', 'f', 'l', 'h', provider);
        assert.ok(registry.cloudWorker instanceof ToolLoopWorker, provider);
        assert.equal(registry.cloudWorker.id, `${provider}-cloud`);
        const factory: any = new Factory('/tmp', '', { strategy: 'cloud', cloudProvider: provider, cloudModel: 'm', plannerProvider: provider });
        assert.equal(factory.planner.provider, provider);
        assert.equal(factory.inspector.provider, provider);
      }
    });
  });
});

describe('.env in the repository', () => {
  it('parses the simple grammar and nothing fancier', () => {
    assert.deepEqual(parseDotEnv('# comment\nA=1\nexport B="two words" \nC=\'x#y\'\nD=plain # trailing\n\nbad line\n=nope\n'), { A: '1', B: 'two words', C: 'x#y', D: 'plain' });
  });

  it('fills names that are not exported and never overrides one that is', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-dotenv-'));
    await fs.writeFile(path.join(dir, '.env'), 'SF_TEST_FROM_FILE=file\nSF_TEST_EXPORTED=file\n');
    const env: NodeJS.ProcessEnv = { SF_TEST_EXPORTED: 'shell' };
    assert.deepEqual(await loadDotEnv(dir, env), ['SF_TEST_FROM_FILE']);
    assert.equal(env.SF_TEST_FROM_FILE, 'file');
    assert.equal(env.SF_TEST_EXPORTED, 'shell');
    assert.deepEqual(await loadDotEnv(await fs.mkdtemp(path.join(os.tmpdir(), 'sf-nodotenv-')), {}), [], 'no file, nothing loaded');
  });
});
