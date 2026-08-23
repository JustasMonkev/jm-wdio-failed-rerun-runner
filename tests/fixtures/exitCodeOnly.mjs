// Reproduces the hazard: WebdriverIO's launcher registers exit-hook, and with it
// registered a process that only sets process.exitCode still exits 0.
import exitHook from 'exit-hook'

exitHook(() => {})
process.exitCode = 1
