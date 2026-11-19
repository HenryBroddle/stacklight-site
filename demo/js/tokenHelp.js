// Where the edit token can be seen on this install (GET /api/state → tokenHelp; src/server/paths.js tokenHelp()):
// the Windows kit's "Show edit token" launcher, else `npm run token` on the server.

/** @param {{ kind?: string, folder?: string }|null|undefined} help */
export function isWindowsKit(help) {
  return help?.kind === 'windows-kit';
}

/** One sentence: where to get the token. */
export function tokenWhere(help) {
  if (isWindowsKit(help)) return `On the HUD computer, open the folder ${kitFolder(help)} and double-click “Show edit token”.`;
  return 'Run “npm run token” on the HUD server to print it.';
}

/** The kit folder named by the server, else the folder the kit's instructions use. */
export function kitFolder(help) {
  return typeof help?.folder === 'string' && help.folder ? help.folder : 'C:\\MachineShopHUD';
}
