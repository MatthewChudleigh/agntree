// Run as a separate process by storage.test.ts to act as another VS Code window:
// `node stateWriter.js <state file> <prefix> <count>` saves <count> changes, as fast as it can.
import { StateStore } from '../../services/StateStore';

const [file, prefix, count] = process.argv.slice(2);
const store = new StateStore(file);
for (let i = 0; i < Number(count); i++) {
  store.update((state) => {
    state.starredChats.push(`${prefix}-${i}`);
  });
}
