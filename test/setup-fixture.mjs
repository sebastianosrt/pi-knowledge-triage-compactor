import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporary } from "./helpers.mjs";
import { UV_VERSION } from "../src/laya/setup.ts";

// Local executables exercise the actual setup subprocess and flock protocol without downloads.
// The separate real-Laya suite verifies the downloaded runtime and inference behavior.
export async function setupFixture(t) {
  const root = await temporary(t), uvRoot = join(root, `uv-${UV_VERSION}`);
  await mkdir(uvRoot);
  const python = `#!${process.execPath}
import fs from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2);
if (args[1].endsWith('install-laya-model.py')) {
 const model=args[2];
 await fs.mkdir(path.join(model,'tokenizer'),{recursive:true});
 for(const file of ['model.safetensors','rl_agent_config.json','tokenizer/tokenizer_config.json']) await fs.writeFile(path.join(model,file),'{}');
} else {
 let raw='';for await(const chunk of process.stdin) raw+=chunk;
 const texts=JSON.parse(raw).texts;
 process.stdout.write(JSON.stringify({results:texts.map(()=>({answers:{knowledge_type:{choice:'preference',answer_confidence:0.99},safety_critical:{noul:0.01,answer_confidence:0.99}},usage:{truncated:false}}))}));
}
`;
  const script = `#!${process.execPath}
import fs from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2),root=${JSON.stringify(root)};
if(args[0]==='venv') {
 await fs.appendFile(path.join(root,'installs'),'x');
 await fs.writeFile(path.join(root,'child-pid'),String(process.pid));
 try { await fs.stat(path.join(root,'pause')); await new Promise(resolve=>setTimeout(resolve,60000)); } catch {}
 const dir=args.at(-1);await fs.mkdir(path.join(dir,'bin'),{recursive:true});
 await fs.writeFile(path.join(dir,'bin/python'),${JSON.stringify(python)},{mode:0o755});
}
`;
  await writeFile(join(uvRoot, "uv"), script, { mode: 0o755 });
  return root;
}

