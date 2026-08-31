// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { listAgentSummaries } from './agents';
import { detectAll } from './local_agents/registry';
import { listInstances } from './messaging/manager';
import { listP3394Peers, syncP3394TeamDirectory } from './p3394_bridge/app-wiring';
import { listExternalGateways } from './p3394_bridge/external-gateways';
import { listRemoteNodes } from './p3394_bridge/remote-nodes';

/** Host-owned discovery facade. CogSeed Backend consumes only its safe,
 * structural projection inputs and never reaches into host runtimes directly. */
export const listCogSeedHostAgentSummaries = listAgentSummaries;
export const listCogSeedHostCliEntries = detectAll;
export const listCogSeedHostChannels = listInstances;
export const listCogSeedHostPeers = listP3394Peers;
export const listCogSeedHostGateways = listExternalGateways;
export const listCogSeedHostRemoteNodes = listRemoteNodes;
export const syncCogSeedHostAgentDirectory = syncP3394TeamDirectory;
