export function prepareSigning(env = process.env, platform = process.platform) {
  // Actions exports missing secrets as empty strings, which electron-builder
  // interprets as a certificate path rather than an unsigned build.
  if (!env.CSC_LINK?.trim()) delete env.CSC_LINK

  const required = env.ADE_REQUIRE_SIGNING === 'true'
  const adHoc =
    platform === 'darwin' &&
    !required &&
    ((!env.CSC_LINK && !env.CSC_NAME?.trim()) || env.CSC_NAME?.trim() === '-')
  if (platform === 'darwin' && required) {
    const credentials = [
      ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
      ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
      ['APPLE_KEYCHAIN_PROFILE'],
    ]
    if (!credentials.some((keys) => keys.every((key) => env[key]?.trim())))
      throw new Error(
        'Required macOS releases need notarization credentials: set APPLE_ID, ' +
          'APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID, or configure an ' +
          'Apple API key or keychain profile for electron-builder.',
      )
  }

  return {
    forceCodeSigning: platform !== 'linux' && required,
    ...(platform === 'darwin' && required ? { mac: { notarize: true } } : {}),
    // Sign the complete bundle so macOS can register ADE for notifications even
    // without a Developer ID certificate. Ad-hoc builds cannot be notarized.
    ...(adHoc
      ? {
          mac: {
            identity: '-',
            notarize: false,
            preAutoEntitlements: false,
            timestamp: 'none',
          },
        }
      : {}),
  }
}
