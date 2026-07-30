#!/usr/bin/env bash

# Read-only host inventory for the AITeam gray deployment gate.
# This script writes only to stdout/stderr. Redirecting it to a root-only file is
# an operator decision and is intentionally not done here.

set -u
export LC_ALL=C

section() {
  printf '\n## %s\n' "$1"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

redact_network() {
  sed -E \
    -e 's/0\.0\.0\.0/<all-ipv4>/g' \
    -e 's/127\.0\.0\.1/<loopback-ipv4>/g' \
    -e 's/\[::\]/<all-ipv6>/g' \
    -e 's/::1/<loopback-ipv6>/g' \
    -e 's/([0-9]{1,3}\.){3}[0-9]{1,3}/<redacted-ipv4>/g' \
    -e 's/([[:xdigit:]]{0,4}:){2,}[[:xdigit:]:]{0,4}(\/[0-9]+)?/<redacted-ipv6>/g'
}

safe_hash() {
  local path="$1"
  if [[ -r "$path" ]] && have sha256sum; then
    sha256sum "$path" | awk '{print $1}'
  else
    printf 'unavailable\n'
  fi
}

printf '# AITeam VPS read-only inventory\n'
printf 'timestamp_utc=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf 'hostname=%s\n' "$(hostname 2>/dev/null || printf 'unknown')"
printf 'effective_uid=%s\n' "$(id -u)"
if [[ "$(id -u)" -eq 0 ]]; then
  printf 'coverage=root\n'
else
  printf 'coverage=limited_non_root\n'
fi
printf 'writes_performed=none_by_script\n'
printf 'provider_control_plane=not_available_from_host\n'

section "Operating system and capacity"
uname -a 2>/dev/null || true
if [[ -r /etc/os-release ]]; then
  grep -E '^(NAME|VERSION|ID|VERSION_ID)=' /etc/os-release || true
fi
have nproc && printf 'cpu_count=%s\n' "$(nproc)"
have uptime && uptime
have free && free -h
df -hT 2>/dev/null || df -h 2>/dev/null || true
df -ih 2>/dev/null || true
have swapon && swapon --show --noheadings 2>/dev/null || true

section "Network and listeners (addresses redacted)"
if have ip; then
  ip -brief link show 2>/dev/null || true
  ip -brief address show 2>/dev/null | redact_network || true
  ip route show default 2>/dev/null | redact_network || true
fi
if have ss; then
  ss -lntupH 2>/dev/null | redact_network || true
fi
printf 'provider_security_group_bindings=control_plane_required\n'
printf 'public_reachability=external_probe_required\n'

section "Host firewall summary"
if have ufw; then
  ufw status 2>/dev/null | head -n 1 || true
fi
if have nft; then
  printf 'nft_rule_lines=%s\n' "$(nft list ruleset 2>/dev/null | wc -l | tr -d ' ')"
fi
if have iptables; then
  printf 'iptables_rule_lines=%s\n' "$(iptables -S 2>/dev/null | wc -l | tr -d ' ')"
fi

section "Docker daemon and workload baseline"
if have docker; then
  docker version --format 'client={{.Client.Version}} server={{.Server.Version}}' 2>/dev/null || true
  printf 'daemon_json_sha256=%s\n' "$(safe_hash /etc/docker/daemon.json)"
  docker compose version 2>/dev/null || true
  if docker info >/dev/null 2>&1; then
    printf 'docker_daemon=accessible\n'
    docker info --format \
      'root_dir={{.DockerRootDir}} driver={{.Driver}} cgroup={{.CgroupDriver}} cpus={{.NCPU}} memory={{.MemTotal}} live_restore={{.LiveRestoreEnabled}} security={{json .SecurityOptions}}' \
      2>/dev/null || true
    docker compose ls 2>/dev/null || true

    printf '\ncontainers:\n'
    docker ps -a --no-trunc \
      --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' \
      2>/dev/null | redact_network || true
    while IFS= read -r container_id; do
      [[ -n "$container_id" ]] || continue
      docker inspect "$container_id" --format \
        'id={{.Id}} name={{.Name}} image={{.Config.Image}} state={{.State.Status}} started={{.State.StartedAt}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} ports={{json .HostConfig.PortBindings}} networks={{json .NetworkSettings.Networks}} mounts={{json .Mounts}}' \
        2>/dev/null | redact_network || true
    done < <(docker ps -aq 2>/dev/null)

    printf '\nimages:\n'
    docker images --digests --no-trunc \
      --format '{{.ID}}\t{{.Repository}}:{{.Tag}}\t{{.Digest}}\t{{.Size}}' \
      2>/dev/null || true
    printf '\nnetworks:\n'
    docker network ls --no-trunc 2>/dev/null || true
    printf '\nvolumes:\n'
    docker volume ls 2>/dev/null || true
  else
    printf 'docker_daemon=unavailable_or_permission_denied\n'
  fi
else
  printf 'docker=unavailable\n'
fi

section "Service managers, timers, and reverse proxies"
if have systemctl; then
  systemctl --no-pager --plain --type=service --state=running 2>/dev/null || true
  systemctl --no-pager --plain list-timers --all 2>/dev/null || true
  for unit in docker nginx caddy fail2ban auditd firewalld ufw; do
    printf '%s=%s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null || printf 'not-active')"
  done
fi
have nginx && nginx -v 2>&1 || true
have caddy && caddy version 2>/dev/null || true
have pm2 && printf 'pm2_binary=present\n'

section "Cron coverage without command disclosure"
for cron_path in /etc/crontab /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /etc/cron.monthly; do
  if [[ -e "$cron_path" ]]; then
    if [[ -d "$cron_path" ]]; then
      printf '%s_entries=%s\n' "$cron_path" \
        "$(find "$cron_path" -mindepth 1 -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')"
    else
      printf '%s_sha256=%s\n' "$cron_path" "$(safe_hash "$cron_path")"
    fi
  fi
done

section "SSH posture and authorized-key fingerprints"
if have sshd; then
  sshd -T 2>/dev/null | grep -E \
    '^(permitrootlogin|passwordauthentication|pubkeyauthentication|kbdinteractiveauthentication|permitemptypasswords|maxauthtries|clientaliveinterval|clientalivecountmax|allowtcpforwarding|x11forwarding) ' \
    || true
fi
while IFS= read -r key_file; do
  printf 'authorized_keys path=%s owner=%s mode=%s sha256=%s\n' \
    "$key_file" \
    "$(stat -c '%U:%G' "$key_file" 2>/dev/null || printf 'unknown')" \
    "$(stat -c '%a' "$key_file" 2>/dev/null || printf 'unknown')" \
    "$(safe_hash "$key_file")"
  if have ssh-keygen; then
    ssh-keygen -lf "$key_file" 2>/dev/null | awk '{print "fingerprint bits=" $1 " sha256=" $2 " type=" $NF}' || true
  fi
done < <(find /root /home -maxdepth 3 -type f -name authorized_keys 2>/dev/null)

section "Interactive users and sudo groups"
awk -F: '($3 == 0 || $3 >= 1000) && $7 !~ /(nologin|false)$/ {print "user=" $1 " uid=" $3 " gid=" $4 " shell=" $7}' \
  /etc/passwd 2>/dev/null || true
getent group sudo 2>/dev/null || true
getent group wheel 2>/dev/null || true

section "Package and security-agent state"
if have apt; then
  printf 'apt_upgradable_count=%s\n' \
    "$(apt list --upgradable 2>/dev/null | sed '1d' | wc -l | tr -d ' ')"
fi
if have dnf; then
  printf 'dnf_binary=present update_state=manual_no_metadata_refresh\n'
fi
if have yum; then
  printf 'yum_binary=present update_state=manual_no_metadata_refresh\n'
fi

section "Backup artifact metadata (contents not read)"
for backup_root in /var/backups /srv/*/backup /srv/*/backups; do
  [[ -d "$backup_root" ]] || continue
  printf 'backup_root=%s owner=%s mode=%s\n' \
    "$backup_root" \
    "$(stat -c '%U:%G' "$backup_root" 2>/dev/null || printf 'unknown')" \
    "$(stat -c '%a' "$backup_root" 2>/dev/null || printf 'unknown')"
  find "$backup_root" -maxdepth 1 -type f -printf \
    'artifact=%p bytes=%s modified=%TY-%Tm-%TdT%TH:%TM:%TSZ\n' \
    2>/dev/null | sort | tail -n 20 || true
done
printf 'application_consistency=manual_evidence_required\n'
printf 'off_host_copy=provider_or_operator_evidence_required\n'
printf 'restoration_test=manual_evidence_required\n'

section "AITeam gray collision gates"
for path in /srv/aiteam-gray /srv/coworker-gray /srv/coworker; do
  if [[ -e "$path" ]]; then
    printf 'path=%s exists=true owner=%s mode=%s\n' \
      "$path" \
      "$(stat -c '%U:%G' "$path" 2>/dev/null || printf 'unknown')" \
      "$(stat -c '%a' "$path" 2>/dev/null || printf 'unknown')"
  else
    printf 'path=%s exists=false\n' "$path"
  fi
done
if have ss; then
  if ss -lntH 'sport = :18787' 2>/dev/null | grep -q .; then
    printf 'loopback_port_18787=occupied\n'
  else
    printf 'loopback_port_18787=free\n'
  fi
fi

section "Coverage gaps"
printf 'vpc_and_security_groups=control_plane_required\n'
printf 'provider_snapshot=control_plane_required\n'
printf 'external_public_probe=separate_observer_required\n'
printf 'backup_restore_semantics=operator_evidence_required\n'
