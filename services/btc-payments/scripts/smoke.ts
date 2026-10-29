import { loadEnv } from '../src/load-env.js';

loadEnv();

const baseUrl = (process.env.PUBLIC_BASE_URL ?? 'http://localhost:4580').replace(
  /\/+$/,
  '',
);

async function check(path: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.text();
    console.log(`${path} -> HTTP ${response.status}`);
    console.log(body);
    return response.ok;
  } catch (err) {
    console.error(
      `${path} -> falhou: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

const health = await check('/health');
const ready = await check('/ready');

if (!health || !ready) process.exitCode = 1;
