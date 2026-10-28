import { logger } from "@chrismessina/raycast-logger";
import { useEffect, useRef } from "react";
import {
  Action,
  ActionPanel,
  Color,
  Icon,
  Image,
  Keyboard,
  List,
  openExtensionPreferences,
  showToast,
  Toast,
} from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";
import { useAuthNavigation } from "./hooks/use-auth-navigation";
import { getStoredCredentials, loginToAppleId, Needs2FAError } from "./utils/auth";
import {
  diagnose,
  diagnosticsReport,
  IPATOOL_RELEASES_URL,
  readIpatoolStatus,
  upgradeIpatoolWithHomebrew,
  type Check,
  type CheckState,
  type Diagnosis,
} from "./utils/doctor";

const STATE_ICON: Record<CheckState, Image.ImageLike> = {
  ok: { source: Icon.CheckCircle, tintColor: Color.Green },
  warn: { source: Icon.Warning, tintColor: Color.Yellow },
  fail: { source: Icon.XMarkCircle, tintColor: Color.Red },
  unknown: { source: Icon.QuestionMarkCircle, tintColor: Color.SecondaryText },
};

/** Searchable words for each state, so "broken" finds the failing checks. */
const STATE_KEYWORDS: Record<CheckState, string[]> = {
  ok: ["ok", "passing", "healthy"],
  warn: ["warn", "warning", "update"],
  fail: ["fail", "failing", "broken", "error"],
  unknown: ["unknown", "unchecked"],
};

export default function Doctor() {
  const { data: diagnosis, isLoading, revalidate } = useCachedPromise(diagnose, [], { keepPreviousData: true });
  const { pushLoginForm, push2FAForm } = useAuthNavigation();
  const remedying = useRef(false);
  // A remedy reports its result in a toast and then re-runs the checks; this
  // keeps that re-run from painting "Running Doctor…" over the result. Cleared
  // once the quiet run finishes.
  const quietRun = useRef(false);

  // One progress toast for the whole run. The session check talks to Apple for
  // several seconds, and the list's loading bar alone reads as stalled.
  useEffect(() => {
    if (!isLoading) {
      quietRun.current = false;
      return;
    }
    if (quietRun.current) return;

    let canceled = false;
    let handle: Toast | undefined;
    showToast({ style: Toast.Style.Animated, title: "Running Doctor…" }).then((toast) => {
      if (canceled) void toast.hide();
      else handle = toast;
    });

    return () => {
      canceled = true;
      void handle?.hide();
    };
  }, [isLoading]);

  async function updateIpatool() {
    const brewPath = diagnosis?.ipatool.brewPath;
    if (!brewPath || remedying.current) return;
    remedying.current = true;

    const from = diagnosis?.ipatool.installed;
    const toast = await showToast({ style: Toast.Style.Animated, title: "Updating ipatool…", message: "brew upgrade" });
    try {
      await upgradeIpatoolWithHomebrew(brewPath);
      // Version only: a full `diagnose()` would also re-run the session probe,
      // which the revalidation below runs anyway.
      const { installed: now, latest } = await readIpatoolStatus();
      if (!now) {
        // brew removes the old Cellar version, so a version-pinned path stops running.
        toast.style = Toast.Style.Failure;
        toast.title = "ipatool No Longer Runs";
        toast.message = "Check the ipatool path in the extension preferences.";
      } else if (latest && now !== latest) {
        // brew succeeded but its formula has not caught up with the release.
        toast.style = Toast.Style.Failure;
        toast.title = `Homebrew Doesn't Have v${latest} Yet`;
        toast.message = `Still on v${now}. Try again later, or install the release by hand.`;
      } else {
        toast.style = Toast.Style.Success;
        toast.title = now && now !== from ? `Updated ipatool to v${now}` : "ipatool Is Up to Date";
        toast.message = undefined;
      }
    } catch (error) {
      logger.error("[doctor] brew upgrade ipatool failed:", error);
      await toast.hide();
      await showFailureToast(error, { title: "Could Not Update ipatool" });
    } finally {
      remedying.current = false;
      quietRun.current = true;
      revalidate();
    }
  }

  /**
   * Signs in with the saved credentials when there are any, so Apple sends a
   * code and the user only types that; otherwise asks for the password.
   */
  async function signIn() {
    const { email, password } = await getStoredCredentials();
    if (!email || !password) {
      await pushLoginForm(revalidate);
      return;
    }

    const toast = await showToast({ style: Toast.Style.Animated, title: "Signing In…", message: email });
    try {
      await loginToAppleId();
      toast.style = Toast.Style.Success;
      toast.title = "Signed In";
      quietRun.current = true;
      revalidate();
    } catch (error) {
      await toast.hide();
      if (error instanceof Needs2FAError) {
        push2FAForm(revalidate);
      } else {
        await pushLoginForm(revalidate);
      }
    }
  }

  function enterCode() {
    // Asks for the password first when none is saved.
    push2FAForm(revalidate);
  }

  function remedyAction(check: Check) {
    switch (check.remedy) {
      case "update-ipatool":
        return <Action title="Update with Homebrew" icon={Icon.Download} onAction={updateIpatool} />;
      case "open-releases":
        return <Action.OpenInBrowser title="Open Release Page" url={IPATOOL_RELEASES_URL} />;
      case "open-preferences":
        return <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />;
      case "sign-in":
        return <Action title="Sign in" icon={Icon.Person} onAction={signIn} />;
      case "enter-code":
        return <Action title="Enter Verification Code" icon={Icon.Key} onAction={enterCode} />;
      default:
        return null;
    }
  }

  function sharedActions(diagnosis?: Diagnosis) {
    return (
      <ActionPanel.Section>
        <Action
          title="Run Checks Again"
          icon={Icon.Repeat}
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={revalidate}
        />
        {diagnosis ? (
          <Action.CopyToClipboard
            title="Copy Diagnostics Report"
            content={diagnosticsReport(diagnosis)}
            shortcut={Keyboard.Shortcut.Common.Copy}
          />
        ) : null}
      </ActionPanel.Section>
    );
  }

  const needAttention = diagnosis?.checks.filter((check) => check.state !== "ok").length ?? 0;

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={diagnosis !== undefined}
      navigationTitle="iOS Apps Doctor"
      searchBarPlaceholder="Filter checks"
      actions={<ActionPanel>{sharedActions(diagnosis)}</ActionPanel>}
    >
      <List.EmptyView
        icon={Icon.Heartbeat}
        title="Running Checks"
        description="Checking ipatool, your Apple ID, and whether Apple accepts your session."
      />
      {diagnosis ? (
        <List.Section title="Checks" subtitle={needAttention === 0 ? "All passing" : `${needAttention} to fix`}>
          {diagnosis.checks.map((check) => (
            <List.Item
              key={check.id}
              icon={STATE_ICON[check.state]}
              title={check.title}
              keywords={STATE_KEYWORDS[check.state]}
              detail={<List.Item.Detail markdown={`## ${check.title}\n\n**${check.summary}**\n\n${check.detail}`} />}
              actions={
                <ActionPanel>
                  {check.remedy ? <ActionPanel.Section>{remedyAction(check)}</ActionPanel.Section> : null}
                  {sharedActions(diagnosis)}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : null}
    </List>
  );
}
