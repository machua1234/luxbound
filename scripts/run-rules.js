// Run the early-warning rules once (e.g. from cron) and exit.
import { runRules } from '../src/rules.js';
console.log(await runRules());
