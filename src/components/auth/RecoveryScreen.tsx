import {
  type Builder,
  generateRecoveryPhrase,
  validateRecoveryPhrase,
} from '@siafoundation/sia-storage'
import { useState } from 'react'
import { connectSiaClient } from '../../lib/connectSiaClient'
import { useAuthStore } from '../../stores/auth'
import { CopyButton } from '../ui/CopyButton'

export function RecoveryScreen({
  builder,
}: {
  builder: React.RefObject<Builder | null>
}) {
  const { setClient, setStoredKeyHex, setError, setJustCreatedAccount } =
    useAuthStore()
  const [mode, setMode] = useState<'choose' | 'generate' | 'import'>('choose')
  const [phrase, setPhrase] = useState('')
  const [generatedPhrase, setGeneratedPhrase] = useState('')
  const [loading, setLoading] = useState(false)
  const [phraseError, setPhraseError] = useState<string | null>(null)

  function handleGenerate() {
    const mnemonic = generateRecoveryPhrase()
    setGeneratedPhrase(mnemonic)
    setPhrase(mnemonic)
    setMode('generate')
  }

  function handleValidatePhrase(value: string) {
    setPhrase(value)
    setPhraseError(null)
    if (value.trim()) {
      try {
        validateRecoveryPhrase(value.trim())
      } catch {
        setPhraseError("That doesn't look like a valid recovery phrase.")
      }
    }
  }

  async function handleRegister() {
    const b = builder.current
    if (!b) {
      setError('No builder instance')
      return
    }

    const mnemonic = phrase.trim()
    try {
      validateRecoveryPhrase(mnemonic)
    } catch {
      setPhraseError("That doesn't look like a valid recovery phrase.")
      return
    }

    setLoading(true)
    try {
      const sdk = await b.register(mnemonic)
      setStoredKeyHex(sdk.appKey().export().toHex())
      // Generate = a brand-new account (nothing to recover); import = restoring an
      // existing one (recover settings from the DHT locator). Set BEFORE setClient
      // (which transitions to connected + runs the settings load) so the load knows
      // whether to attempt recovery.
      setJustCreatedAccount(mode === 'generate')
      const { indexerURL } = useAuthStore.getState()
      setClient(await connectSiaClient(sdk, indexerURL))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  if (mode === 'choose') {
    return (
      <div className="space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold text-neutral-900 tracking-tight">
            Your custody key
          </h1>
          <p className="text-neutral-600 text-sm leading-relaxed">
            A 12-word phrase that controls your Pin account. Anyone with it can
            read and publish your channels — keep it private.
          </p>
        </div>

        <div className="space-y-2">
          <button
            type="button"
            onClick={handleGenerate}
            className="w-full py-3 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors"
          >
            Create a new account
          </button>
          <button
            type="button"
            onClick={() => setMode('import')}
            className="w-full py-3 bg-neutral-100 hover:bg-neutral-200 text-neutral-900 font-medium rounded-lg transition-colors"
          >
            I have a recovery phrase
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-semibold text-neutral-900 tracking-tight">
          {mode === 'generate' ? 'Save these 12 words' : 'Welcome back'}
        </h1>
        <p className="text-neutral-600 text-sm leading-relaxed">
          {mode === 'generate'
            ? "Write them down somewhere safe. They're the only way back into your account if you lose this browser."
            : 'Enter your 12-word recovery phrase to restore your account.'}
        </p>
      </div>

      {mode === 'generate' ? (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2 p-4 bg-white rounded-lg border border-neutral-300">
            {generatedPhrase.split(' ').map((word, i) => (
              <div
                key={`${word}-${i}`}
                className="text-center py-2 bg-neutral-100 rounded text-sm"
              >
                <span className="text-neutral-400 mr-1">{i + 1}.</span>
                <span className="text-neutral-900">{word}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <CopyButton
              value={generatedPhrase}
              label="Recovery phrase copied"
            />
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            value={phrase}
            onChange={(e) => handleValidatePhrase(e.target.value)}
            placeholder="word word word word word word word word word word word word"
            rows={3}
            className="w-full px-4 py-3 bg-white border border-neutral-300 rounded-lg text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600"
          />
          {phraseError && <p className="text-red-600 text-sm">{phraseError}</p>}
        </div>
      )}

      <div className="space-y-2">
        <button
          type="button"
          onClick={handleRegister}
          disabled={loading || !phrase.trim()}
          className="w-full py-3 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white font-medium rounded-lg transition-colors"
        >
          {loading
            ? 'Setting up…'
            : mode === 'generate'
              ? "I've saved it — continue"
              : 'Restore my account'}
        </button>
        <button
          type="button"
          onClick={() => {
            setMode('choose')
            setPhrase('')
            setGeneratedPhrase('')
            setPhraseError(null)
          }}
          className="w-full py-2 text-neutral-500 hover:text-neutral-900 text-sm transition-colors"
        >
          Back
        </button>
      </div>
    </div>
  )
}
