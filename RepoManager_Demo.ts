import { RepoManager } from './RepoManager';

async function main() {
  // Load repository
  const repo = await RepoManager.load('./tmp', { exclude: [/node_modules/, /^\.[^/]/] });

  // View with chunks expanded
  console.log(repo.view({"000001000000": true}));

  // Edit a block
  await repo.edit({"000001000000": `
function multiply(a, b) {

  // testing edit functionality

  return a * b;

}`
  });

  //// Verify
  //console.log(repo.view({ '000001000000': true }));
}

main().catch(console.error);
