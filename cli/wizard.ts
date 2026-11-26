// Controller wizard setup — pegang data preset & penyimpanan config;
// tampilannya di src/ui/screens/wizard.ts.
import { detectAndSave } from "../src/providers/provision.ts"
import { t } from "../src/ui/i18n/locale.ts"
import { runSetupWizardView } from "../src/ui/screens/wizard.ts"

export async function runSetupWizard(): Promise<boolean> {
  return runSetupWizardView({
    onSubmit: async (baseUrl, apiKey, signal) => {
      const fallbackModels = baseUrl.includes("anthropic") ? ["claude-sonnet-4"] : ["gpt-4o-mini"]
      const entry = await detectAndSave(baseUrl, apiKey, undefined, {
        fallbackModels,
        rejectUnreachable: true,
        signal,
      })
      return t("ntc.saved", { id: entry.id, n: entry.models.length, scope: "global" })
    },
  })
}
