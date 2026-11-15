// Importing this module registers every command. App code imports commands from the domain files;
// an agent bridge would use call() / listCommands() / toolDefinitions().
import './gym';
import './food';
import './body';
import './analysis';

export { call, listCommands, run, toolDefinitions } from './registry';
export * as gym from './gym';
export * as food from './food';
export * as body from './body';
export * as analysis from './analysis';
