// Test identity: a build that can run beside the installed TerminAI without sharing
// its bundle id, its userData folder (~/Library/Application Support/<name>) or file associations.
const base = require('./package.json').build
module.exports = {
  ...base,
  appId: 'com.clipwave.term.test',
  productName: 'TerminAI Test',
  extraMetadata: { name: 'terminai-test' },
  fileAssociations: [],
  directories: { output: 'release-test' },
}
