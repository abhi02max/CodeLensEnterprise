// Operator-only local Docker proof. Excluded from both production images.
const { spawn, execFileSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { mkdirSync, writeFileSync, existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const docker = process.argv[2];
if (!docker) throw new Error('Pass the operator Docker executable');
const project = 'codelens_phase3f_foundation_20261004';
const root = resolve('.codelens-tmp/phase3f-foundation');
const keyFile = resolve(root, 'validation-key');
const base = ['compose', '-p', project, '-f', 'infra/validation/compose.foundation.yml'];
const call = (...args) =>
  execFileSync(docker, args, { encoding: 'utf8', timeout: 60000, env: environment });
mkdirSync(root, { recursive: true });
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
const image = execFileSync(
  docker,
  ['image', 'inspect', 'codelens-phase3f-foundation-executor:local', '--format', '{{.Id}}'],
  { encoding: 'utf8' },
).trim();
const environment = {
  ...process.env,
  VALIDATION_EXECUTOR_IMAGE: image,
  VALIDATION_KEY_FILE: keyFile,
};
const before = call('ps', '-a', '--format', '{{.ID}} {{.Names}}')
  .split('\n')
  .filter((line) => line && !line.includes(project))
  .sort();
const client = `
const net=require('node:net'),fs=require('node:fs'),crypto=require('node:crypto');
const {signRequest,verifyResult}=require('/protocol.cjs');
let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
 const parsed=JSON.parse(input),key=fs.readFileSync('/run/secrets/validation-key');
 const request=signRequest(key,crypto.randomUUID(),parsed.input);
 const socket=net.connect('/control/validation.sock');let bytes=Buffer.alloc(0);
 const timer=setTimeout(()=>{socket.destroy();process.exitCode=2},115000);
 socket.on('error',()=>{clearTimeout(timer);process.exitCode=2});
 socket.on('connect',()=>{const body=Buffer.from(JSON.stringify(request)),head=Buffer.alloc(4);head.writeUInt32BE(body.length);socket.write(Buffer.concat([head,body]));
 if(parsed.cancelAfter)setTimeout(()=>socket.destroy(),parsed.cancelAfter);});
 socket.on('data',b=>{bytes=Buffer.concat([bytes,b]);if(bytes.length>65540)socket.destroy();});
 socket.on('end',()=>{clearTimeout(timer);try{if(bytes.readUInt32BE(0)!==bytes.length-4)throw Error();const result=verifyResult(key,request.nonce,JSON.parse(bytes.subarray(4).toString()));process.stdout.write(JSON.stringify(result));}catch{process.exitCode=2}});
 socket.on('close',()=>{clearTimeout(timer);if(parsed.cancelAfter)process.stdout.write(JSON.stringify({cancelled:true}));});
});`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let broker;
const proof = { project, image, backend: 'docker-local-proof', cases: [], inspections: [] };
const input = (content, profile = 'vitest-unit-v1', path = 'fixture.test.ts') => ({
  version: 1,
  profile,
  files: [
    {
      path: 'package.json',
      content: JSON.stringify({
        name: 'validation-fixture',
        private: true,
        scripts: { test: 'THIS_MUST_NEVER_RUN' },
      }),
    },
    { path, content },
  ],
});
const test = (body) =>
  `import { test, expect } from 'vitest';\nimport fs from 'node:fs';\nimport net from 'node:net';\nimport {spawn} from 'node:child_process';\ntest('bounded fixture',async()=>{${body}});`;
async function execute(name, data, expected, options = {}) {
  let output = '',
    errors = '';
  const child = spawn(docker, ['exec', '-i', broker, '/nodejs/bin/node', '-e', client], {
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => {
    output += b;
  });
  child.stderr.on('data', (b) => {
    errors += b;
  });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`broker client failed ${name}: ${errors.slice(0, 200)}`)),
    );
  });
  child.stdin.end(JSON.stringify({ input: data, cancelAfter: options.cancelAfter }));
  if (options.inspect) {
    let container;
    for (let n = 0; n < 100; n++) {
      const names = call(
        'ps',
        '--filter',
        'label=com.codelens.validation.namespace=' + project,
        '--format',
        '{{.Names}}',
      )
        .trim()
        .split('\n');
      container = names.find((name) => name.includes('-execute-'));
      if (container) break;
      await sleep(100);
    }
    assert(container, 'real executor must be observable');
    const value = JSON.parse(call('inspect', container))[0];
    assert.equal(value.Config.Image, image);
    assert.equal(value.Config.User, '65532:65532');
    assert.equal(value.HostConfig.NetworkMode, 'none');
    assert.equal(value.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(value.HostConfig.CapDrop, ['ALL']);
    assert(value.HostConfig.SecurityOpt.some((v) => v.startsWith('no-new-privileges')));
    assert(value.HostConfig.SecurityOpt.some((v) => v.startsWith('seccomp=')));
    assert.equal(value.HostConfig.Privileged, false);
    assert.equal(value.HostConfig.PidsLimit, 64);
    assert.equal(value.HostConfig.Memory, 536870912);
    assert.equal(value.HostConfig.MemorySwap, 536870912);
    assert.equal(value.HostConfig.NanoCpus, 500000000);
    assert.deepEqual(value.HostConfig.Devices, []);
    assert.equal(value.HostConfig.PidMode, '');
    assert.equal(value.HostConfig.IpcMode, 'private');
    assert.equal(value.Mounts.length, 1);
    assert.equal(value.Mounts[0].Type, 'volume');
    assert.equal(value.Mounts[0].Destination, '/input');
    assert.equal(value.Mounts[0].RW, false);
    assert(value.Mounts[0].Name.startsWith(project + '-input-'));
    assert.deepEqual(value.Config.Env, [
      'LANG=C.UTF-8',
      'LC_ALL=C.UTF-8',
      'TZ=UTC',
      'PATH=/nodejs/bin',
      'HOME=/tmp/home',
      'TMPDIR=/tmp',
      'NODE_ENV=test',
      'SSL_CERT_FILE=',
    ]);
    proof.inspections.push({
      image: value.Config.Image,
      user: value.Config.User,
      environment: value.Config.Env,
      network: value.HostConfig.NetworkMode,
      readonly: value.HostConfig.ReadonlyRootfs,
      capabilities: value.HostConfig.CapDrop,
      noNewPrivileges: true,
      seccomp: true,
      sourceReadOnly: true,
      pids: value.HostConfig.PidsLimit,
      memory: value.HostConfig.Memory,
      memorySwap: value.HostConfig.MemorySwap,
      nanoCpus: value.HostConfig.NanoCpus,
      ulimits: value.HostConfig.Ulimits,
      tmpfs: value.HostConfig.Tmpfs,
    });
  }
  await completed;
  const result = JSON.parse(output);
  proof.lastResult = result;
  expected(result);
  for (let n = 0; n < 100; n++) {
    const containers = call(
      'ps',
      '-a',
      '--filter',
      'label=com.codelens.validation.namespace=' + project,
      '--format',
      '{{.Names}}',
    ).trim();
    const volumes = call(
      'volume',
      'ls',
      '--filter',
      'label=com.codelens.validation.namespace=' + project,
      '--format',
      '{{.Name}}',
    ).trim();
    if (!containers && !volumes) break;
    await sleep(200);
  }
  assert.equal(
    call(
      'ps',
      '-a',
      '--filter',
      'label=com.codelens.validation.namespace=' + project,
      '--format',
      '{{.Names}}',
    ).trim(),
    '',
    'owned executor/preparer cleanup',
  );
  assert.equal(
    call(
      'volume',
      'ls',
      '--filter',
      'label=com.codelens.validation.namespace=' + project,
      '--format',
      '{{.Name}}',
    ).trim(),
    '',
    'owned input cleanup',
  );
  proof.cases.push({ name, ...result });
  console.log(name + ': passed');
}
const exited =
  (failed = 0) =>
  (r) => {
    assert.equal(r.status, 'VALIDATION_EXECUTED');
    assert.equal(r.observed.termination, 'EXITED');
    assert.equal(r.observed.cleanup, 'DISPOSED');
    assert.equal(r.runnerReported.status, 'VALID');
    assert.equal(r.runnerReported.trusted, false);
    assert.equal(r.runnerReported.report.failed, failed);
    assert.equal(r.observed.exitCode, failed ? 1 : 0);
  };
async function main() {
  console.log(call(...base, 'config', '--services').trim());
  call(...base, 'up', '-d');
  broker = call(...base, 'ps', '-q', 'validation-broker').trim();
  await sleep(1500);
  await execute(
    'typecheck pass',
    input('export const value: number = 1;', 'typescript-typecheck-v1', 'src/a.ts'),
    exited(),
  );
  await execute(
    'typecheck fail',
    input('export const value: number = "wrong";', 'typescript-typecheck-v1', 'src/a.ts'),
    exited(1),
  );
  await execute('unit pass', input(test('expect(2+2).toBe(4);')), exited());
  await execute('unit fail', input(test('expect(2+2).toBe(5);')), exited(1));
  await execute(
    'actual policy/environment/readonly/loopback',
    input(
      test(`
    expect(process.getuid()).toBe(65532);expect(process.getgid()).toBe(65532);
    expect(Object.keys(process.env).some(k=>/SECRET|TOKEN|PASSWORD|KEY|DATABASE|REDIS|GITHUB|OPENAI|GEMINI|AWS/.test(k))).toBe(false);
    expect(()=>fs.readFileSync('/var/run/docker.sock')).toThrow();expect(()=>fs.readFileSync('/run/secrets/validation-key')).toThrow();
    expect(()=>fs.writeFileSync('/input/escape','x')).toThrow();expect(()=>fs.writeFileSync('/root/escape','x')).toThrow();
    expect(()=>fs.readFileSync('C:/Users/Abhid/OneDrive/Documents/CodeLens Enterprise/.env')).toThrow();
    const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));await new Promise(r=>server.close(r));
    await new Promise(r=>setTimeout(r,2000));`),
    ),
    exited(),
    { inspect: true },
  );
  await execute(
    'network destinations denied',
    input(
      test(`
    for(const [host,port] of [['1.1.1.1',443],['github.com',443],['registry.npmjs.org',443],['169.254.169.254',80],['host.docker.internal',80],['172.17.0.1',80],['172.17.0.1',4000],['172.17.0.1',5432],['172.17.0.1',6379],['172.17.0.1',8000],['172.17.0.1',2375]]){
      const connected=await new Promise(r=>{const s=net.connect({host,port});const done=v=>{s.destroy();r(v)};s.on('connect',()=>done(true));s.on('error',()=>done(false));s.setTimeout(200,()=>done(false));});expect(connected).toBe(false);
    }`),
    ),
    exited(),
  );
  for (const [name, body] of [
    [
      'ANSI/control output',
      `console.log('\\x1b]8;;https://invalid\\x07\\x1b[31mhello\\x1b[0m\\u202e');`,
    ],
    ['traversal/write denied', `expect(()=>fs.writeFileSync('/input/../escape','x')).toThrow();`],
    [
      'filesystem exhaustion',
      `let denied=false;try{for(let i=0;i<100;i++)fs.writeFileSync('/tmp/fill-'+i,Buffer.alloc(1048576))}catch(e){denied=e.code==='ENOSPC'}expect(denied).toBe(true);`,
    ],
  ])
    await execute(name, input(test(body)), (r) => {
      exited()(r);
      assert(!/[\x1b\u202e]/.test(r.observed.stdout.excerpt));
    });
  for (const [name, body] of [
    ['generated symlink report', `fs.symlinkSync('/input/package.json','/output/report.json');`],
    [
      'hardlink report',
      `fs.writeFileSync('/output/link-source','{}');fs.linkSync('/output/link-source','/output/report.json');`,
    ],
    [
      'malformed report',
      `fs.writeFileSync('/output/report.json','bad');fs.chmodSync('/output/report.json',0o400);`,
    ],
    [
      'oversized report',
      `fs.writeFileSync('/output/report.json','x'.repeat(70000));fs.chmodSync('/output/report.json',0o400);`,
    ],
    ['unexpected output file', `fs.writeFileSync('/output/unexpected','x');`],
  ])
    await execute(name, input(test(body)), (r) => {
      assert.equal(r.observed.cleanup, 'DISPOSED');
      assert.equal(r.runnerReported.status, 'REJECTED');
    });
  for (const [name, body, termination] of [
    [
      'stdout flood',
      `const bytes=Buffer.alloc(65536,120);while(true){try{fs.writeSync(1,bytes)}catch(e){if(!['EAGAIN','EINTR'].includes(e.code))throw e}}`,
      'OUTPUT_LIMIT',
    ],
    [
      'stderr flood',
      `const bytes=Buffer.alloc(65536,120);while(true){try{fs.writeSync(2,bytes)}catch(e){if(!['EAGAIN','EINTR'].includes(e.code))throw e}}`,
      'OUTPUT_LIMIT',
    ],
    ['infinite loop', `while(true){}`, 'TIMEOUT'],
    [
      'background child',
      `const child=spawn('/nodejs/bin/node',['-e','while(true){}'],{stdio:'inherit',detached:true});expect(child.pid).toBeGreaterThan(0);await new Promise(r=>setTimeout(r,100000));`,
      'EXITED',
    ],
  ])
    await execute(name, input(test(body)), (r) => {
      assert.equal(r.status, 'VALIDATION_EXECUTED');
      assert.equal(r.observed.termination, termination);
      assert.equal(r.observed.cleanup, 'DISPOSED');
      assert(r.observed.stdout.capturedBytes <= 1048576);
      assert(r.observed.stderr.capturedBytes <= 1048576);
      if (name === 'background child') assert.equal(r.observed.exitCode, 1);
    });
  await execute(
    'child-process storm',
    input(
      test(
        `const children=[];let denied=false;for(let i=0;i<150;i++){const c=spawn('/nodejs/bin/node',['-e','setTimeout(()=>{},100000)'],{stdio:'ignore'});children.push(c);c.on('error',()=>denied=true);}await new Promise(r=>setTimeout(r,1500));for(const c of children)c.kill();expect(denied).toBe(true);`,
      ),
    ),
    (r) => {
      assert.equal(r.observed.cleanup, 'DISPOSED');
      assert.equal(r.status, 'VALIDATION_EXECUTED');
    },
  );
  await execute(
    'memory exhaustion',
    input(test(`const b=[];while(true){const x=Buffer.alloc(16*1024*1024,1);b.push(x)}`)),
    (r) => {
      assert.equal(r.observed.cleanup, 'DISPOSED');
      assert.equal(r.status, 'VALIDATION_EXECUTED');
      assert(r.observed.oom || r.observed.exitCode !== 0);
    },
  );
  await execute(
    'active cancellation/process tree',
    input(test(`spawn('/nodejs/bin/node',['-e','while(true){}'],{stdio:'inherit'});while(true){}`)),
    (r) => assert.equal(r.cancelled, true),
    { cancelAfter: 4000, inspect: true },
  );
  await sleep(1000);
  call(...base, 'restart', 'validation-broker');
  await sleep(1500);
  await execute('restart normal execution', input(test('expect(true).toBe(true)')), exited());
  const unsupported = input('', 'vitest-unit-v1');
  unsupported.files.push({ path: 'pnpm-lock.yaml', content: 'invalid' });
  await execute('unsupported dependencies fail closed', unsupported, (r) => {
    assert.equal(r.status, 'UNSUPPORTED');
    assert.equal(r.observed.started, false);
  });
  const after = call('ps', '-a', '--format', '{{.ID}} {{.Names}}')
    .split('\n')
    .filter((line) => line && !line.includes(project))
    .sort();
  assert.deepEqual(after, before, 'existing Docker container identities unchanged');
  proof.existingResourcesUntouched = true;
  writeFileSync(resolve(root, 'runtime-proof.json'), JSON.stringify(proof, null, 2));
  console.log('FOUNDATION LOCAL RUNTIME PROOF PASSED');
}
main().catch((error) => {
  writeFileSync(resolve(root, 'runtime-proof.partial.json'), JSON.stringify(proof, null, 2));
  console.error(error.message);
  process.exitCode = 1;
});
