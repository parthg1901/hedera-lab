/** Standalone entry for the same combined-fault checks used by the recovery pack. */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runTicketStress } from "../dist/verification/ticketStress.js";
export { runTicketStress as runStress };
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const report = await runTicketStress(
    path.resolve(process.argv[2] ?? "examples/lab-ticketing"),
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
