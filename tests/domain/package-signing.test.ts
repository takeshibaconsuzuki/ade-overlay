import assert from 'node:assert/strict'
import { test } from 'node:test'

const { prepareSigning } = await import(
  new URL('../../scripts/package-signing.mjs', import.meta.url).href
)

test('manual macOS packaging signs ad-hoc without a certificate', () => {
  for (const certificate of [undefined, '', '  ']) {
    const env = { CSC_LINK: certificate }
    assert.deepEqual(prepareSigning(env, 'darwin'), {
      forceCodeSigning: false,
      mac: {
        identity: '-',
        notarize: false,
        preAutoEntitlements: false,
        timestamp: 'none',
      },
    })
    assert.equal(Object.hasOwn(env, 'CSC_LINK'), false)
  }
})

test('manual macOS packaging honors explicit certificate signing', () => {
  for (const env of [
    { CSC_LINK: '/certificate.p12', CSC_KEY_PASSWORD: '' },
    { CSC_NAME: 'Example Developer (TEAM)' },
  ]) {
    const original = { ...env }
    assert.deepEqual(prepareSigning(env, 'darwin'), { forceCodeSigning: false })
    assert.deepEqual(env, original)
  }
})

test('explicit ad-hoc signing disables notarization even with Apple credentials', () => {
  const config = prepareSigning(
    { CSC_NAME: '-', APPLE_KEYCHAIN_PROFILE: 'notarization' },
    'darwin',
  )
  assert.equal(config.mac.identity, '-')
  assert.equal(config.mac.notarize, false)
})

test('required macOS releases reject absent and incomplete notarization credentials', () => {
  const credentials = {
    APPLE_ID: 'developer@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: 'password',
    APPLE_TEAM_ID: 'team',
  }
  for (const incomplete of [
    {},
    { APPLE_ID: '', APPLE_APP_SPECIFIC_PASSWORD: '', APPLE_TEAM_ID: '' },
    ...Object.keys(credentials).map((key) => ({ ...credentials, [key]: '' })),
    { APPLE_KEYCHAIN: 'build.keychain' },
    { APPLE_API_KEY: '/key.p8', APPLE_API_KEY_ID: 'key' },
  ]) {
    assert.throws(
      () =>
        prepareSigning(
          {
            ADE_REQUIRE_SIGNING: 'true',
            CSC_LINK: '/certificate.p12',
            ...incomplete,
          },
          'darwin',
        ),
      /notarization credentials/,
    )
  }
  for (const complete of [
    credentials,
    {
      APPLE_API_KEY: '/key.p8',
      APPLE_API_KEY_ID: 'key',
      APPLE_API_ISSUER: 'issuer',
    },
    { APPLE_KEYCHAIN_PROFILE: 'notarization' },
  ]) {
    assert.deepEqual(
      prepareSigning({ ADE_REQUIRE_SIGNING: 'true', ...complete }, 'darwin'),
      { forceCodeSigning: true, mac: { notarize: true } },
    )
  }
})

test('other platforms do not require Apple credentials', () => {
  for (const platform of ['win32', 'linux'])
    assert.deepEqual(prepareSigning({}, platform), { forceCodeSigning: false })
  assert.deepEqual(prepareSigning({ ADE_REQUIRE_SIGNING: 'true' }, 'win32'), {
    forceCodeSigning: true,
  })
  assert.deepEqual(prepareSigning({ ADE_REQUIRE_SIGNING: 'true' }, 'linux'), {
    forceCodeSigning: false,
  })
})
