import path from "node:path";
import { readdir, readFile, lstat, realpath, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stringify } from "yaml";
import { parseScenario } from "./schema.js";
import { prepareApplicationOperations } from "./plan.js";
import { runScenario } from "./runner.js";

const digest = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const ignored = new Set(["node_modules", ".git", ".harness", "dist", "build", "coverage", "verification"]);
export interface OnboardingConfig {
  schemaVersion: 1;
  entry: string;
  exportName: string;
  input: string;
  format: "transfers" | "plan";
  actor: string;
  expected: Record<string, number>;
}

async function safeFile(root: string, name: string): Promise<string> {
  if (path.isAbsolute(name) || name.includes("\\") || name.split("/").some(p => !p || p === "." || p === ".."))
    throw Error("Use a relative project file without traversal or symlinks");
  let current = root;
  for (const part of name.split("/")) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw Error("Symlink inputs are not supported");
  }
  const info = await lstat(current);
  if (!info.isFile() || info.size > 262144) throw Error("Input must be a regular file no larger than 256 KiB");
  if (/^(?:\.env|.*\.(?:pem|key))$/i.test(path.basename(name))) throw Error("Credential files are not application inputs");
  return current;
}

/** Discovery reads filenames and export declarations; it never imports application code. */
export async function inspectApplication(workspace: string) {
  const root = await realpath(workspace);
  const candidates: Array<{ file: string; exports: string[] }> = [];
  const inputs: string[] = [];
  let visited = 0;
  let truncated = false;
  async function walk(dir: string, depth: number): Promise<void> {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (++visited > 2000) { truncated = true; return; }
      if (item.name.startsWith(".") || ignored.has(item.name) || item.isSymbolicLink()) continue;
      const full = path.join(dir, item.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (item.isDirectory() && depth < 4) await walk(full, depth + 1);
      else if (item.isFile() && /\.(mjs|js|ts)$/.test(item.name) && (await lstat(full)).size <= 262144) {
        const source = await readFile(full, "utf8");
        const exports = [...source.matchAll(/\bexport\s+(?:async\s+)?function\s+(\w+)|\bexport\s+const\s+(\w+)\s*=/g)].map(m => m[1] ?? m[2]);
        if (/\bexport\s+default\b/.test(source)) exports.push("default");
        if (exports.length) candidates.push({ file: relative, exports });
      } else if (item.isFile() && /\.json$/.test(item.name) && !/(package|lock|tsconfig|catalog|credential|secret|account)/i.test(item.name)) inputs.push(relative);
    }
  }
  await walk(root, 0);
  return { candidates, inputs, truncated, note: "Heuristic candidates only; no application code executed. Compile TypeScript to JavaScript before onboarding." };
}

export function parseExpectations(value: string, actor: string): Record<string, number> {
  const expected: Record<string, number> = {};
  for (const pair of value.split(",")) {
    const [recipient, amount, extra] = pair.trim().split("=");
    if (extra !== undefined || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(recipient ?? "") || [actor, "__proto__", "constructor", "prototype"].includes(recipient) || Object.hasOwn(expected, recipient)) throw Error("Recipients must be unique fixture names, distinct from the payer");
    if (!/^\d+(?:\.\d{1,8})?$/.test(amount ?? "") || Number(amount) <= 0 || Number(amount) > 1000) throw Error("Approved amounts must be positive HBAR with at most 8 decimals, at most 1000 each");
    expected[recipient] = Number(amount);
  }
  if (Object.keys(expected).length > 20) throw Error("At most 20 approved recipients are supported");
  return expected;
}

function validateConfig(config: OnboardingConfig): void {
  if (config.schemaVersion !== 1 || !["transfers", "plan"].includes(config.format) || !/^[A-Za-z_$][\w$]*$/.test(config.exportName) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(config.actor) || ["__proto__", "constructor", "prototype"].includes(config.actor)) throw Error("Invalid onboarding configuration");
  if (!config.expected || typeof config.expected !== "object" || Array.isArray(config.expected) || !Object.keys(config.expected).length) throw Error("Customer-approved recipient amounts are required");
  if (Object.values(config.expected).some(v => typeof v !== "number" || !Number.isFinite(v) || Math.abs(Math.round(v * 1e8) / 1e8 - v) > 1e-12)) throw Error("Approved amounts must be numeric HBAR with at most 8 decimals");
  parseExpectations(Object.entries(config.expected).map(([k,v]) => `${k}=${typeof v === "number" && Number.isFinite(v) ? v.toFixed(8) : v}`).join(","), config.actor);
}

function scenarioFor(config: OnboardingConfig, count: number, mode: "simulated" | "testnet") {
  const accounts: Record<string, {hbar: number}> = {};
  const total = Object.values(config.expected).reduce((s,n) => s + Math.round(n * 1e8), 0);
  accounts[config.actor] = { hbar: (total + 100000000) / 1e8 };
  for (const name of Object.keys(config.expected)) accounts[name] = { hbar: 1 };
  return parseScenario({ schemaVersion: 1, name: "Customer-approved HBAR payouts", network: {mode}, fixtures: {accounts, tokens: {}, topics: []}, timeoutMs: mode === "simulated" ? 50 : 8000, pollIntervalMs: 10,
    steps: [
      ...Array.from({length: count}, (_,index) => ({id: `payout-${index+1}`, planOperation: {file: "verification/payout-plan.json", index}})),
      ...Object.entries(config.expected).map(([account,amount], index) => ({id: `approved-${index+1}`, assert: {type: "hbarBalance", account, min: (100000000 + Math.round(amount*1e8))/1e8, max: (100000000 + Math.round(amount*1e8))/1e8}}))
    ] });
}

// Runs only on the customer's machine with explicit --allow-execution. It is not
// an arbitrary-code sandbox. Application stdout is discarded; output is a file.
function adapterSource() {
  return `import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [root,configFile,output]=process.argv.slice(2);
const config=JSON.parse(await readFile(configFile,'utf8'));
const module=await import(pathToFileURL(path.join(root,config.entry)).href);
if(typeof module[config.exportName]!=='function')throw Error('Selected export is not callable');
const result=await module[config.exportName](JSON.parse(await readFile(path.join(root,config.input),'utf8')));
let plan=result;
if(config.format==='transfers'){
 if(!Array.isArray(result))throw Error('Expected an array of {recipient, amount}; provide an adapter for another output shape');
 plan={schemaVersion:1,operations:result.map(row=>{
  if(!row||Object.keys(row).some(k=>!['recipient','amount'].includes(k)))throw Error('Expected exact {recipient, amount} rows');
  return {type:'transferHbar',actor:config.actor,to:row.recipient,amount:row.amount};
 })};
}
if(!plan||!Array.isArray(plan.operations)||plan.operations.length<1||plan.operations.length>20||plan.operations.some(o=>o.type!=='transferHbar'||o.actor!==config.actor))throw Error('Onboarding currently supports 1–20 HBAR payouts by the approved payer only');
const text=JSON.stringify(plan,null,2)+'\\n';
if(Buffer.byteLength(text)>65536)throw Error('Plan exceeds 64 KiB');
await writeFile(output,text,{flag:'wx',mode:0o600});
`;
}

async function executeAdapter(root: string, folder: string, timeoutMs = 15000) {
  const destination = path.join(folder, `candidate-${randomUUID()}.json`);
  const env: NodeJS.ProcessEnv = {};
  // No payer, cloud, agent, NODE_OPTIONS or provider credentials inherited.
  for (const key of ["PATH", "LANG", "TZ", "SYSTEMROOT"]) if (process.env[key]) env[key] = process.env[key];
  try {
    await new Promise<void>((resolve,reject) => {
      const child = spawn(process.execPath, [path.join(folder,"build-plan.mjs"), root, path.join(folder,"onboarding.json"), destination], {cwd: root, env, stdio: "ignore", detached: process.platform !== "win32"});
      const timer = setTimeout(() => { if (child.pid) { try { process.kill(process.platform === "win32" ? child.pid : -child.pid,"SIGKILL"); } catch {} } reject(Error("Application build timed out")); }, timeoutMs);
      child.on("error", e => {clearTimeout(timer); reject(e);});
      child.on("exit", code => {clearTimeout(timer); code === 0 ? resolve() : reject(Error("Application adapter failed. Check the selected export and output shape; see ADAPTER.md. Application output is suppressed to avoid leaking secrets."));});
    });
    const file = await safeFile(folder, path.basename(destination));
    const raw = await readFile(file,"utf8");
    if (Buffer.byteLength(raw)>65536) throw Error("Plan exceeds 64 KiB");
    return JSON.parse(raw);
  } finally { await rm(destination,{force:true}); }
}

export async function initializeOnboarding(rootName: string, config: OnboardingConfig, allowExecution: boolean) {
  if (!allowExecution) throw Error("Building calls your application locally. Review it first, then pass --allow-execution; this is not a code sandbox.");
  const root = await realpath(rootName);
  validateConfig(config);
  await safeFile(root,config.entry); await safeFile(root,config.input);
  if (!/\.(js|mjs|cjs)$/.test(config.entry)) throw Error("Compile the selected entry to JavaScript first");
  const folder = path.join(root,"verification");
  await mkdir(folder); // Exclusive: never overwrite an existing integration.
  await writeFile(path.join(folder,"onboarding.json"),json(config),{flag:"wx"});
  await writeFile(path.join(folder,"build-plan.mjs"),adapterSource(),{flag:"wx"});
  await writeFile(path.join(folder,"ADAPTER.md"), `# Local application adapter\n\nThis adapter imports ${config.entry} and calls ${config.exportName} with ${config.input}.\nIt runs on your computer, outside the signing worker. It is not sandboxed.\nSupported outputs: an array of exact {recipient, amount} rows, or a Lab plan of HBAR transfers.\nFor another shape, expose a pure exported function wrapping the REAL business logic; do not replace it with hardcoded approved outcomes.\nNo dependency installation, arbitrary repo upload, browser verification or duplicate-payment guarantee is provided by this wizard.\n\nIf initial generation fails, inspect these files and preserve or rename verification/ before trying init again. Existing files are never overwritten.\n`);
  const plan = await executeAdapter(root,folder);
  const count = plan?.operations?.length;
  if (!Number.isInteger(count) || count < 1 || count > 20) throw Error("Expected 1–20 application operations");
  await writeFile(path.join(folder,"payout-plan.json"),json(plan),{flag:"wx"});
  const simulated = scenarioFor(config,count,"simulated");
  await prepareApplicationOperations(simulated,root);
  await mkdir(path.join(folder,"scenarios"));
  await writeFile(path.join(folder,"scenarios/simulated.yaml"),stringify(simulated));
  await writeFile(path.join(folder,"scenarios/testnet.yaml"),stringify(scenarioFor(config,count,"testnet")));
  const terms = `# Review your verification contract\n\nApplication: ${config.entry}, export ${config.exportName}; input: ${config.input}.\n\n${Object.entries(config.expected).map(([name,n]) => `- ${name} must receive exactly ${n} HBAR; its disposable account starts with 1 HBAR.`).join("\n")}\n\nPayer: ${config.actor}. All accounts are disposable fixture aliases.\nThese amounts were supplied by you, not inferred from application output.\nThe generated adapter must call the same business logic used by your app.\n\nLocal dry runs use simulation and cost no service payment. A simulation pass does not prove network behavior. Testnet requires provider registration and a fresh priced quote, or your own configured operator for direct Lab execution.\nNo hosted registration or service price has been invented. Customer budget approval is a separate step.\nThis package checks final recipient balances for this input, not retries, UI, authentication, arbitrary contracts or every possible input.\n\nReview the adapter and assertions, then use lab onboard approve.\n`;
  await writeFile(path.join(folder,"CONTRACT.md"),terms);
  await writeFile(path.join(folder,"provider-handoff.json"),json({schemaVersion:1,status:"requires-provider-registration",workspace:".",scenario:"verification/scenarios/testnet.yaml",sourceEntry:config.entry,input:config.input,requiredProviderWork:["Review reproducible application build and acceptance requirements","Set service price and execution funding limits","Register matching immutable artifacts with API and worker","Expose readiness and request a new customer-approved quote"]}));
  await writeFile(path.join(folder,".gitignore"),"runs/\napproval.json\nlast-run.json\ncandidate-*.json\n");
  return dryRun(root,folder);
}

const protectedFiles = ["onboarding.json","build-plan.mjs","CONTRACT.md","scenarios/simulated.yaml","scenarios/testnet.yaml","provider-handoff.json"];
async function contractHash(folder: string) {
  const contents = await Promise.all(protectedFiles.map(async file => [file,await readFile(await safeFile(folder,file),"utf8")]));
  return digest(json(contents));
}
async function dryRun(root: string, folder: string) {
  const output = path.join(folder,"runs",randomUUID());
  const report = await runScenario({file:path.join(folder,"scenarios/simulated.yaml"),workspace:root,outputDirectory:output});
  // Source/input linkage is evidence, not an assertion of semantic equivalence.
  const config: OnboardingConfig = JSON.parse(await readFile(path.join(folder,"onboarding.json"),"utf8"));
  await writeFile(path.join(folder,"last-run.json"),json({runId:report.runId,passed:report.passed,mode:report.mode,entrySha256:digest(await readFile(await safeFile(root,config.entry))),inputSha256:digest(await readFile(await safeFile(root,config.input))),report:path.relative(root,path.join(output,"index.html"))}));
  return report;
}
export async function approveOnboarding(rootName: string) {
  const root=await realpath(rootName); const folder=path.join(root,"verification");
  await safeFile(root,"verification/onboarding.json");
  const hash=await contractHash(folder);
  await writeFile(path.join(folder,"approval.json"),json({contractHash:hash,approvedAt:new Date().toISOString()}),{flag:"wx",mode:0o600});
  return hash;
}
export async function checkOnboarding(rootName: string, allowExecution: boolean) {
  if (!allowExecution) throw Error("Pass --allow-execution to rebuild the application locally");
  const root=await realpath(rootName); const folder=path.join(root,"verification");
  await safeFile(root,"verification/onboarding.json");
  const approval=JSON.parse(await readFile(await safeFile(folder,"approval.json"),"utf8"));
  const before=await contractHash(folder);
  if(approval.contractHash!==before)throw Error("Reviewed contract changed; inspect the diff and explicitly renew approval before running");
  const config: OnboardingConfig=JSON.parse(await readFile(path.join(folder,"onboarding.json"),"utf8"));
  validateConfig(config); await safeFile(root,config.entry); await safeFile(root,config.input);
  const plan=await executeAdapter(root,folder);
  if(await contractHash(folder)!==before)throw Error("Application build changed protected verification files");
  const temp=path.join(folder,`validation-${randomUUID()}`);
  await mkdir(temp);
  try {
    await mkdir(path.join(temp,"verification"));
    await writeFile(path.join(temp,"verification/payout-plan.json"),json(plan));
    const {loadScenario}=await import("./schema.js");
    const {scenario}=await loadScenario(path.join(folder,"scenarios/simulated.yaml"));
    await prepareApplicationOperations(scenario,temp);
  } finally {await rm(temp,{recursive:true,force:true});}
  const next=path.join(folder,`candidate-${randomUUID()}.json`);
  await writeFile(next,json(plan),{flag:"wx"}); await rename(next,path.join(folder,"payout-plan.json"));
  return dryRun(root,folder);
}

export async function runOnboardingCli(args: string[]) {
  const [action,...rest]=args;
  const options: Record<string,string>={};
  let allow=false;
  for(let i=0;i<rest.length;i++){
    if(rest[i]==="--allow-execution"){allow=true;continue;}
    if(!["--workspace","--entry","--export","--input","--format","--actor","--expect"].includes(rest[i])||!rest[i+1]||rest[i+1].startsWith("--"))throw Error(`Invalid onboarding option ${rest[i]}`);
    if(options[rest[i]])throw Error(`Duplicate option ${rest[i]}`);
    options[rest[i]]=rest[++i];
  }
  const root=path.resolve(options["--workspace"]??process.cwd());
  if(action==="inspect"){console.log(json(await inspectApplication(root)));return;}
  if(action==="approve"){console.log(`Reviewed contract recorded: ${await approveOnboarding(root)}`);return;}
  let report;
  if(action==="check")report=await checkOnboarding(root,allow);
  else if(action==="init"){
    const discovery=await inspectApplication(root);
    console.log(json(discovery));
    const rl=process.stdin.isTTY?createInterface({input:process.stdin,output:process.stdout}):undefined;
    async function ask(flag:string,label:string,fallback?:string){
      if(options[flag])return options[flag];
      if(!rl){if(fallback)return fallback;throw Error(`Supply ${flag}, or run interactively`);}
      const answer=(await rl.question(`${label}${fallback?` [${fallback}]`:""}: `)).trim();
      if(!answer&&!fallback)throw Error(`${label} is required`);
      return answer||fallback!;
    }
    try {
      const entry=await ask("--entry","Application entry file",discovery.candidates.length===1?discovery.candidates[0].file:undefined);
      const candidate=discovery.candidates.find(c=>c.file===entry);
      const exportName=await ask("--export","Function that prepares payouts",candidate?.exports.length===1?candidate.exports[0]:undefined);
      const input=await ask("--input","Representative JSON input file",discovery.inputs.length===1?discovery.inputs[0]:undefined);
      const format=await ask("--format","Output shape: transfers ({recipient, amount}[]) or plan","transfers") as OnboardingConfig["format"];
      const actor=await ask("--actor","Disposable payer name","treasury");
      const expected=parseExpectations(await ask("--expect","Approved payouts from requirements, e.g. alice=0.75,bob=0.25"),actor);
      if(!allow&&rl)allow=(await rl.question("This imports your application locally without a sandbox. Run this trusted code now? [yes/no]: ")).trim()==="yes";
      report=await initializeOnboarding(root,{schemaVersion:1,entry,exportName,input,format,actor,expected},allow);
    }finally{rl?.close();}
  }else throw Error("Usage: lab onboard <inspect|init|approve|check> [--workspace path]; init/check require --allow-execution in noninteractive mode");
  console.log(`${report.passed?"PASS":"FAIL"} — free simulated verification; no payment or network transaction.`);
  for(const event of report.events.filter(e=>e.status==="failed"))console.log(`${event.id}: ${event.message}`);
  const run = JSON.parse(await readFile(path.join(root,"verification/last-run.json"),"utf8"));
  console.log(`Report: ${path.join(root,run.report)}`);
  console.log("Review verification/CONTRACT.md and build-plan.mjs. Record review with lab onboard approve; rerun with lab onboard check --allow-execution. Provider registration remains separate.");
  if(!report.passed)process.exitCode=1;
}
