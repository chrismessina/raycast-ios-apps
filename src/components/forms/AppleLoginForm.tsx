import { Form, ActionPanel, Action } from "@raycast/api";
import { useState } from "react";
import { showFailureToast } from "@raycast/utils";
import { logger } from "@chrismessina/raycast-logger";

interface AppleLoginFormProps {
  onSubmit: (credentials: { email: string; password: string }) => void | Promise<void>;
  initialEmail?: string;
}

export function AppleLoginForm({ onSubmit, initialEmail }: AppleLoginFormProps) {
  const [email, setEmail] = useState(initialEmail ?? "");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | undefined>();
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit() {
    if (!email) {
      setEmailError("Apple ID is required");
      return;
    }

    if (!email.includes("@")) {
      setEmailError("Please enter a valid Apple ID");
      return;
    }

    if (!password) {
      setPasswordError("Password is required");
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit({ email, password });
    } catch (error) {
      logger.error("[Auth] Login form error", error);
      await showFailureToast(error, { title: "Login failed" });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Form
      isLoading={isSubmitting}
      navigationTitle="Sign In to Apple ID"
      actions={
        <ActionPanel>
          <Action.SubmitForm title={isSubmitting ? "Signing In…" : "Sign In"} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="email"
        title="Apple ID"
        placeholder="Enter your Apple ID"
        value={email}
        onChange={(value) => {
          setEmail(value);
          setEmailError(undefined);
        }}
        error={emailError}
      />
      <Form.PasswordField
        id="password"
        title="Password"
        placeholder="Enter your Apple password"
        value={password}
        onChange={(value) => {
          setPassword(value);
          setPasswordError(undefined);
        }}
        error={passwordError}
      />
    </Form>
  );
}
