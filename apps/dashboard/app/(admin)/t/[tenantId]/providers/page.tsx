import { SUPPORTED_PROVIDERS } from "@zeropoint/schemas";
import type { Metadata } from "next";
import { ConfirmAction } from "@/components/confirm-action";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminDb } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { getTenant, listCredentials } from "@/lib/queries";
import { removeCredential } from "./actions";
import { CredentialForm } from "./credential-form";

export const metadata: Metadata = { title: "Provider credentials" };

const LABELS: Record<string, { name: string; endpoint: string }> = {
  openai: { name: "OpenAI", endpoint: "POST /v1/chat/completions" },
  anthropic: { name: "Anthropic", endpoint: "POST /v1/messages" },
  gemini: { name: "Google Gemini", endpoint: "POST /v1beta/models/<model>:generateContent" },
};

export default async function ProvidersPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const db = await getAdminDb();
  const tenant = await getTenant(db, tenantId);
  const credentials = await listCredentials(db, tenant.id);

  return (
    <>
      <PageHeader
        title="Provider credentials"
        description="The tenant's real provider keys. Encrypted with AES-256-GCM before they are stored, and never shown again."
      />
      <div className="grid gap-4 lg:grid-cols-3">
        {SUPPORTED_PROVIDERS.map((provider) => {
          const updatedAt = credentials.get(provider) ?? null;
          const label = LABELS[provider] ?? { name: provider, endpoint: "" };
          return (
            <Card key={provider}>
              <CardHeader>
                <CardTitle>{label.name}</CardTitle>
                <CardDescription className="font-mono text-xs">x-provider: {provider}</CardDescription>
                <CardAction>
                  {updatedAt ? <Badge>Configured</Badge> : <Badge variant="outline">Not configured</Badge>}
                </CardAction>
              </CardHeader>
              <CardContent className="grid gap-4">
                <p className="text-xs text-muted-foreground">
                  {updatedAt ? `Updated ${formatDateTime(updatedAt)}.` : "Requests for this provider get 400 PROVIDER_NOT_CONFIGURED."}{" "}
                  Endpoint: <span className="font-mono">{label.endpoint}</span>
                </p>
                <CredentialForm tenantId={tenant.id} provider={provider} configured={updatedAt !== null} />
                {updatedAt ? (
                  <div>
                    <ConfirmAction
                      action={removeCredential}
                      fields={{ tenantId: tenant.id, provider }}
                      trigger="Remove key"
                      title={`Remove the ${label.name} key?`}
                      description={`Requests for ${label.name} will fail with 400 PROVIDER_NOT_CONFIGURED until a new key is saved.`}
                      confirmLabel="Remove"
                    />
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
