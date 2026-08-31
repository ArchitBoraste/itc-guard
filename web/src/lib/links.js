// Outward links. One place, because a wrong repository URL in the UI is a dead
// link in front of a judge and there is no build step that would catch it.

export const REPO_URL = 'https://github.com/ArchitBoraste/itc-guard';

// One tax period's three sample files, committed so the link from the Summary
// screen resolves. fixtures/ itself is generated and gitignored.
export const SAMPLES_URL = `${REPO_URL}/tree/main/samples`;
