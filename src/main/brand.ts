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

export const RUNTIME_VARIANTS = Object.freeze([
  'main',
  'cognition',
  'expense',
  'integration',
] as const);

export type RuntimeVariant = typeof RUNTIME_VARIANTS[number];

export type RuntimeIdentity = Readonly<{
  variant: RuntimeVariant;
  appName: string;
  appId: string;
  protocolOwner: boolean;
}>;

const SOURCE_IDENTITIES: Readonly<Record<RuntimeVariant, RuntimeIdentity>> = Object.freeze({
  main: Object.freeze({
    variant: 'main',
    appName: `${APP_BRAND.appName} [Main]`,
    appId: `${APP_BRAND.appId}.source.main`,
    protocolOwner: false,
  }),
  cognition: Object.freeze({
    variant: 'cognition',
    appName: `${APP_BRAND.appName} [Cognition]`,
    appId: `${APP_BRAND.appId}.source.cognition`,
    protocolOwner: false,
  }),
  expense: Object.freeze({
    variant: 'expense',
    appName: `${APP_BRAND.appName} [Expense]`,
    appId: `${APP_BRAND.appId}.source.expense`,
    protocolOwner: false,
  }),
  integration: Object.freeze({
    variant: 'integration',
    appName: `${APP_BRAND.appName} [Integration]`,
    appId: `${APP_BRAND.appId}.source.integration`,
    protocolOwner: true,
  }),
});

export function parseRuntimeVariant(value: string | undefined): RuntimeVariant {
  const variant = String(value || '').trim();
  if (!(RUNTIME_VARIANTS as readonly string[]).includes(variant)) {
    throw new Error(
      `invalid ORKAS_RUNTIME_VARIANT ${JSON.stringify(value)}; expected ${RUNTIME_VARIANTS.join('|')}`,
    );
  }
  return variant as RuntimeVariant;
}

export function resolveRuntimeIdentity(
  isPackaged: boolean,
  value: string | undefined = process.env.ORKAS_RUNTIME_VARIANT,
): RuntimeIdentity {
  if (isPackaged) {
    if (value && value !== 'main') {
      throw new Error('packaged Mate Agent only supports the main runtime variant');
    }
    return Object.freeze({
      variant: 'main',
      appName: APP_BRAND.appName,
      appId: APP_BRAND.appId,
      protocolOwner: true,
    });
  }
  return SOURCE_IDENTITIES[parseRuntimeVariant(value)];
}
