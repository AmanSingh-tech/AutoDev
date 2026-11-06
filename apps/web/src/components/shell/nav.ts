import { Bot, ChartColumn, FolderGit2, Gauge, LayoutDashboard, ListChecks, MoonStar, Server, Settings, Users, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Only this exact path is "current" (Home would otherwise match every page). */
  exact?: boolean;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

export interface NavAccess {
  canSeeOverview: boolean;
  canSeeLeaderboard: boolean;
  isAdmin: boolean;
}

/** The sidebar, grouped. Insights shows for whoever can open part of it; Group Agent for admins. */
export function navGroups(access: NavAccess | undefined): NavGroup[] {
  const team: NavItem[] = [{ href: 'members', label: 'Members', icon: Users }];
  if (access && (access.canSeeOverview || access.canSeeLeaderboard))
    team.push({ href: access.canSeeOverview ? 'insights' : 'insights/leaderboard', label: 'Insights', icon: ChartColumn });
  team.push({ href: 'usage', label: 'Usage', icon: Gauge });

  const org: NavItem[] = [];
  if (access?.isAdmin) org.push({ href: 'group-agent', label: 'Group Agent', icon: Bot });
  org.push({ href: 'settings', label: 'Settings', icon: Settings });

  return [
    { label: null, items: [{ href: '', label: 'Home', icon: LayoutDashboard, exact: true }] },
    {
      label: 'Work',
      items: [
        { href: 'tasks', label: 'Tasks', icon: ListChecks },
        { href: 'autopilot', label: 'Autopilot', icon: MoonStar },
        { href: 'repos', label: 'Repositories', icon: FolderGit2 },
        { href: 'builders', label: 'Builders', icon: Server },
      ],
    },
    { label: 'Team', items: team },
    { label: 'Organization', items: org },
  ];
}

export const hrefFor = (slug: string, item: NavItem) => (item.href ? `/o/${slug}/${item.href}` : `/o/${slug}`);

export const isCurrent = (pathname: string, slug: string, item: NavItem) => {
  const href = hrefFor(slug, item);
  return item.exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
};
