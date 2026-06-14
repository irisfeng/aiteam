import { useState } from "react";
import { useWorkspace } from "./store";
import type { Agent, Channel } from "./types";
import { AgentProfileModal } from "./components/AgentProfile";
import { Sidebar } from "./components/Sidebar";
import { ChannelView } from "./components/ChannelView";
import { TasksBoard } from "./components/TasksBoard";
import { InboxView } from "./components/InboxView";
import { DocsView } from "./components/DocsView";
import { TeamView } from "./components/TeamView";
import { UsageView } from "./components/UsageView";
import { ChannelSettingsModal, NewAgentModal, NewChannelModal, SettingsModal } from "./components/Modals";
import { MockBanner, WelcomeOverlay } from "./components/Onboarding";
import { LoginView } from "./components/LoginView";

export default function App() {
  const ws = useWorkspace();
  const [modal, setModal] = useState<"channel" | "agent" | "settings" | null>(null);
  const [configChannel, setConfigChannel] = useState<Channel | null>(null);
  const [profileAgent, setProfileAgent] = useState<Agent | null>(null);

  if (ws.authed === false) return <LoginView />;
  if (!ws.ready) {
    return <div className="flex h-full items-center justify-center text-ink-3">加载中…</div>;
  }

  return (
    <div className="flex h-full">
      <Sidebar
        onNewChannel={() => setModal("channel")}
        onNewAgent={() => setModal("agent")}
        onSettings={() => setModal("settings")}
        onConfigChannel={setConfigChannel}
        onOpenProfile={setProfileAgent}
      />
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <MockBanner onSettings={() => setModal("settings")} />
        <div className="flex min-h-0 flex-1">
          {ws.view.kind === "channel" && <ChannelView channelId={ws.view.id} />}
          {ws.view.kind === "tasks" && <TasksBoard />}
          {ws.view.kind === "inbox" && <InboxView />}
          {ws.view.kind === "docs" && <DocsView />}
          {ws.view.kind === "team" && <TeamView onOpenProfile={setProfileAgent} />}
          {ws.view.kind === "usage" && <UsageView />}
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
      {modal === "settings" && <SettingsModal onClose={() => setModal(null)} />}
      {profileAgent && <AgentProfileModal agent={profileAgent} onClose={() => setProfileAgent(null)} />}
      <WelcomeOverlay onSettings={() => setModal("settings")} onNewChannel={() => setModal("channel")} />
    </div>
  );
}
