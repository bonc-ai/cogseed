import brand from '../resources/brand.json';

export const APP_BRAND = Object.freeze({
  appName: brand.appName,
  zhName: brand.zhName,
  appId: brand.appId,
  protocolScheme: brand.protocolScheme,
  legacyConnectorScheme: brand.legacyConnectorScheme,
  taglineZh: brand.taglineZh,
});

export const CONNECTOR_PROTOCOL_SCHEMES = Object.freeze([
  APP_BRAND.protocolScheme,
  APP_BRAND.legacyConnectorScheme,
] as const);
