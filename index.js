// -----------------------------------------------------------------------------
// Entry point: wires the Gladys SDK to the MPD hub (src/app.js). No device
// logic here. Handlers are registered before connect().
//
// Environment provided by the Gladys supervisor: GLADYS_HOST_API_URL,
// GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR (read by the SDK).
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { registerHandlers } from './src/app.js';

const gladys = new GladysIntegration();
const app = registerHandlers(gladys);

gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal}, stopping`);
  return app.stop(); // closes the connections to the players
});

logger.info('Starting the Music Player Daemon integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
