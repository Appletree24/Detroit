import { caseSchema } from "../contracts";
import { evaluate } from "../eval/verifier";

const item = caseSchema.parse(await Bun.file("/control/case.json").json());
const result = await evaluate(item, "/workspace", { dropPrivileges: true });
process.stdout.write(`${JSON.stringify(result)}\n`);
