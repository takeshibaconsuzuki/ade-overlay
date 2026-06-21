const codesignIdentity =
  process.env.SKIP_CODESIGN === '1'
    ? null
    : (process.env.CODESIGN_IDENTITY ?? '-')

module.exports = {
  appId: process.env.APP_ID ?? 'com.ade-overlay.app',
  productName: process.env.PRODUCT_NAME ?? 'ADE Overlay',
  asar: false,
  directories: {
    output: 'dist',
  },
  files: ['out/**', 'package.json'],
  afterPack: 'scripts/electron-builder-after-pack.mjs',
  mac: {
    category: 'public.app-category.developer-tools',
    hardenedRuntime: codesignIdentity === '-' ? false : undefined,
    icon: 'resources/icons/controller.icns',
    identity: codesignIdentity,
    target: [
      {
        target: 'dir',
      },
    ],
  },
}
