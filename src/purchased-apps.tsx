import { logger } from "@chrismessina/raycast-logger";
import { useEffect, useState } from "react";
import { Action, ActionPanel, Color, Icon, Keyboard, List, LocalStorage } from "@raycast/api";
import { AppActionPanelContent } from "./components/app-action-panel";
import { AppListItem } from "./components/app-list-item";
import { useAppDownload, useFavoriteApps } from "./hooks";
import { useAuthNavigation } from "./hooks/use-auth-navigation";
import { PurchasedApp, PurchasesSortKey, usePurchasedApps } from "./hooks/use-purchased-apps";
import { Needs2FAError, NeedsLoginError } from "./utils/auth";
import { formatFriendlyDateTime } from "./utils/formatting";

const SORT_STORAGE_KEY = "purchased-apps-sort";
const DEFAULT_SORT: PurchasesSortKey = "date-desc";

const SORT_OPTIONS: { title: string; value: PurchasesSortKey }[] = [
  { title: "Purchase Date (Newest)", value: "date-desc" },
  { title: "Purchase Date (Oldest)", value: "date-asc" },
  { title: "Name (A–Z)", value: "name-asc" },
  { title: "Name (Z–A)", value: "name-desc" },
];

function isSortKey(value: string): value is PurchasesSortKey {
  return SORT_OPTIONS.some((option) => option.value === value);
}

export default function PurchasedApps() {
  // Sticky sort, same LocalStorage pattern as the search command's view mode.
  const [sortKey, setSortKey] = useState<PurchasesSortKey>(DEFAULT_SORT);
  const [isSortLoaded, setIsSortLoaded] = useState(false);

  useEffect(() => {
    async function loadSort() {
      // The gate must open on EVERY path. It drives `execute` on the paginated
      // hook, so a rejected read would leave the list on a permanent spinner
      // that never issues a request. The default sort is perfectly usable.
      try {
        const saved = await LocalStorage.getItem<string>(SORT_STORAGE_KEY);
        if (saved && isSortKey(saved)) {
          setSortKey(saved);
        }
      } catch (error) {
        logger.error("[Purchases] Could not restore saved sort; using the default:", error);
      } finally {
        setIsSortLoaded(true);
      }
    }
    loadSort();
  }, []);

  const handleSortChange = async (value: string) => {
    if (!isSortKey(value) || value === sortKey) {
      return;
    }
    setSortKey(value);
    await LocalStorage.setItem(SORT_STORAGE_KEY, value);
  };

  const authNavigation = useAuthNavigation();
  const { downloadAppDetails } = useAppDownload(authNavigation);
  const { isFavorite, addFavorite, removeFavorite } = useFavoriteApps();
  const { apps, isLoading, error, pagination, revalidate, totalCount, loadedCount } = usePurchasedApps(
    sortKey,
    isSortLoaded,
  );

  const isNameSorted = sortKey === "name-asc" || sortKey === "name-desc";
  const needsSignIn = error instanceof NeedsLoginError || error instanceof Needs2FAError;

  const refreshAction = (
    <Action
      title="Refresh Purchases"
      icon={Icon.ArrowClockwise}
      onAction={revalidate}
      shortcut={Keyboard.Shortcut.Common.Refresh}
    />
  );

  const sortDropdown = (
    <List.Dropdown tooltip="Sort purchases" value={sortKey} onChange={handleSortChange}>
      {SORT_OPTIONS.map((option) => (
        <List.Dropdown.Item key={option.value} title={option.title} value={option.value} />
      ))}
    </List.Dropdown>
  );

  const renderRow = (item: PurchasedApp) => {
    const { app, purchaseDate, isListed } = item;
    const key = `${app.id}-${purchaseDate}`;
    const purchased = formatFriendlyDateTime(purchaseDate);

    // Delisted apps have no icon, price, rating, or release date to show, so
    // they get their own row rather than five blank accessories and a "Free"
    // badge inferred from a price field that is 0 on every purchase record.
    if (!isListed) {
      return (
        <List.Item
          key={key}
          title={app.name}
          subtitle={purchased}
          icon={Icon.AppWindow}
          accessories={[
            { text: app.version },
            {
              tag: { value: "Not on App Store", color: Color.SecondaryText },
              tooltip: "Apple no longer lists this app",
            },
            {
              icon: { source: isFavorite(app.bundleId) ? Icon.Heart : Icon.HeartDisabled, tintColor: Color.Magenta },
              tooltip: isFavorite(app.bundleId) ? "Favorited" : "Not Favorited",
            },
          ]}
          actions={
            <ActionPanel>
              <AppActionPanelContent
                app={app}
                onDownload={downloadAppDetails}
                showViewDetails={true}
                isFavorited={isFavorite(app.bundleId)}
                onAddFavorite={addFavorite}
                onRemoveFavorite={removeFavorite}
              />
              <ActionPanel.Section>{refreshAction}</ActionPanel.Section>
            </ActionPanel>
          }
        />
      );
    }

    return (
      <AppListItem
        key={key}
        app={app}
        subtitle={app.sellerName ? `${purchased} · ${app.sellerName}` : purchased}
        // Only the CURRENT store price is knowable here; ipatool's purchase
        // record carries price 0 for every app. Showing either would assert
        // something false about what was paid.
        showPrice={false}
        isFavorited={isFavorite(app.bundleId)}
        onDownload={downloadAppDetails}
        onAddFavorite={addFavorite}
        onRemoveFavorite={removeFavorite}
      >
        <ActionPanel.Section>{refreshAction}</ActionPanel.Section>
      </AppListItem>
    );
  };

  if (error) {
    return (
      <List isLoading={false} searchBarAccessory={sortDropdown}>
        <List.EmptyView
          icon={{ source: Icon.Warning, tintColor: Color.Red }}
          title="Couldn't Load Your Purchases"
          description={
            needsSignIn
              ? "Sign in with your Apple ID, then press ⌘R to try again."
              : `${error.message}\n\nCheck that ipatool 2.5.0 or newer is installed (ipatool list-purchases needs it), then press ⌘R.`
          }
          actions={
            <ActionPanel>
              {needsSignIn && (
                <Action
                  title="Sign in with Apple ID"
                  icon={Icon.Person}
                  onAction={() => authNavigation.pushLoginForm(revalidate)}
                />
              )}
              {refreshAction}
              <Action.CopyToClipboard
                title="Copy Error"
                content={error.message}
                shortcut={Keyboard.Shortcut.Common.Copy}
              />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  return (
    <List
      isLoading={isLoading || !isSortLoaded}
      pagination={pagination}
      searchBarPlaceholder="Filter loaded purchases..."
      navigationTitle="Purchased Apps"
      searchBarAccessory={sortDropdown}
      actions={<ActionPanel>{refreshAction}</ActionPanel>}
    >
      {apps.length === 0 && isLoading ? (
        <List.EmptyView
          icon={Icon.Clock}
          title="Loading Your Purchases…"
          description={
            "ipatool is asking Apple for your library. The first page takes a few seconds — " +
            "it is per-request overhead, not per-app. Later visits open from cache."
          }
        />
      ) : apps.length === 0 ? (
        <List.EmptyView
          icon={Icon.Download}
          title="No Purchases Found"
          description="This Apple ID has no App Store purchases, or ipatool couldn't read them. Press ⌘R to try again."
          actions={<ActionPanel>{refreshAction}</ActionPanel>}
        />
      ) : (
        <List.Section
          title={
            isNameSorted ? `Sorted by name — ${loadedCount} of ${totalCount || loadedCount} loaded` : "Purchased Apps"
          }
          subtitle={isNameSorted ? "Scroll to load more, then the sort widens" : `${loadedCount} of ${totalCount}`}
        >
          {apps.map(renderRow)}
        </List.Section>
      )}
    </List>
  );
}
