import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminDecision } from "@/lib/auth";
import { signOut } from "./actions";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

const MESSAGES: Record<string, string> = {
  not_allowlisted: "This account is not on the admin allowlist. Ask an existing admin to add your email.",
  unconfirmed_email: "Confirm your email address first, then sign in again.",
  link_invalid: "That sign-in link is invalid or has expired. Request a new one.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const decision = await getAdminDecision();
  if (decision.allowed) redirect("/");
  const { error } = await searchParams;
  const message = error ? MESSAGES[error] : undefined;
  const signedInButNotAllowed = decision.reason !== "no_session";

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-mono tracking-tight">ZEROPOINT</CardTitle>
          <CardDescription>Administrator sign-in</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {message ? (
            <Alert variant="destructive">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}
          {signedInButNotAllowed ? (
            <form action={signOut}>
              <Button type="submit" variant="outline" className="w-full">
                Sign out and use another account
              </Button>
            </form>
          ) : (
            <LoginForm />
          )}
        </CardContent>
      </Card>
    </main>
  );
}
