import { Suspense, lazy, useEffect, useState } from "react";
import { useWorkspace } from "./store";
import type { Agent, Channel } from "./types";
import { AgentProfileModal } from "./components/AgentProfile";
import { MobileNav, Sidebar } from "./components/Sidebar";
import { ChannelView } from "./components/ChannelView";
import { TasksBoard } from "./components/TasksBoard";
import { WorklineView } from "./components/WorklineView";
import { InboxView } from "./components/InboxView";
import { ChannelSettingsModal, NewAgentModal, NewChannelModal, SettingsModal, type SettingsTab } from "./components/Modals";
import { MockBanner } from "./components/Onboarding";
import { LoginView } from "./components/LoginView";

const DocsView = lazy(() => import("./components/DocsView").then((m) => ({ default: m.DocsView })));
const TeamView = lazy(() => import("./components/TeamView").then((m) => ({ default: m.TeamView })));
const UsageView = lazy(() => import("./components/UsageView").then((m) => ({ default: m.UsageView })));

function ViewLoading() {
  return <div className="flex h-full flex-1 items-center justify-center text-[13px] text-ink-3">加载视图…</div>;
}

export default function App() {
  const ws = useWorkspace();
  const [modal, setModal] = useState<"channel" | "agent" | "settings" | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("providers");
  const [configChannel, setConfigChannel] = useState<Channel | null>(null);
  const [profileAgent, setProfileAgent] = useState<Agent | null>(null);
  const [deepTaskId, setDeepTaskId] = useState<string | null>(null);
  const [deepApprovalId, setDeepApprovalId] = useState<string | null>(null);

  useEffect(() => {
    if (!ws.ready) return;
    const params = new URLSearchParams(window.location.search);
    const channelId = params.get("channel");
    const view = params.get("view");
    const taskId = params.get("task");
    const approvalId = params.get("approval");
    const hasDeepTarget = Boolean(channelId || view || taskId || approvalId);
    if (channelId && ws.channels.some((c) => c.id === channelId)) ws.openChannel(channelId);
    else if (taskId || view === "tasks") ws.setView({ kind: "tasks" });
    else if (approvalId || view === "inbox") ws.setView({ kind: "inbox" });
    else if (view === "workline") ws.setView({ kind: "workline" });
    if (taskId) setDeepTaskId(taskId);
    if (approvalId) setDeepApprovalId(approvalId);
    if (hasDeepTarget) window.history.replaceState(null, "", import.meta.env.BASE_URL);
  }, [ws.ready]);

  if (ws.authed === false) return <LoginView />;
  if (!ws.ready) {
    return <div className="flex h-full items-center justify-center text-ink-3">加载中…</div>;
  }

  const openSettings = (tab: SettingsTab = "providers") => {
    setSettingsTab(tab);
    setModal("settings");
  };

  const openTaskFromModal = (taskId: string) => {
    setDeepTaskId(taskId);
    ws.setView({ kind: "tasks" });
    setModal(null);
  };

  return (
    <div className="flex h-full">
      <Sidebar
        onNewChannel={() => setModal("channel")}
        onNewAgent={() => setModal("agent")}
        onSettings={() => openSettings("providers")}
        onConfigChannel={setConfigChannel}
        onOpenProfile={setProfileAgent}
      />
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <MobileNav onSettings={() => openSettings("providers")} />
        <MockBanner onSettings={() => openSettings("providers")} />
        <div className="flex min-h-0 flex-1">
          {ws.view.kind === "channel" && <ChannelView channelId={ws.view.id} />}
          {ws.view.kind === "workline" && <WorklineView onOpenSettings={openSettings} />}
          {ws.view.kind === "tasks" && (
            <TasksBoard
              deepTaskId={deepTaskId}
              onDeepTaskConsumed={() => setDeepTaskId(null)}
            />
          )}
          {ws.view.kind === "inbox" && <InboxView focusApprovalId={deepApprovalId} onFocusConsumed={() => setDeepApprovalId(null)} />}
          {ws.view.kind === "docs" && (
            <Suspense fallback={<ViewLoading />}>
              <DocsView />
            </Suspense>
          )}
          {ws.view.kind === "team" && (
            <Suspense fallback={<ViewLoading />}>
              <TeamView onOpenProfile={setProfileAgent} onOpenTask={openTaskFromModal} />
            </Suspense>
          )}
          {ws.view.kind === "usage" && (
            <Suspense fallback={<ViewLoading />}>
              <UsageView />
            </Suspense>
          )}
        </div>
      </main>
      {modal === "channel" && <NewChannelModal onClose={() => setModal(null)} onCustomRole={() => setModal("agent")} />}
      {configChannel && (
        <ChannelSettingsModal
          channel={configChannel}
          onClose={() => setConfigChannel(null)}
          onCustomRole={() => setModal("agent")}
        />
      )}
      {modal === "agent" && <NewAgentModal onClose={() => setModal(null)} />}
      {modal === "settings" && <SettingsModal initialTab={settingsTab} onClose={() => setModal(null)} onOpenTask={openTaskFromModal} />}
      {profileAgent && <AgentProfileModal agent={profileAgent} onClose={() => setProfileAgent(null)} />}
    </div>
  );
}
