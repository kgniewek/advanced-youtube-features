import {
	App,
	ButtonComponent,
	Editor,
	MarkdownView,
	ItemView,
	Menu,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	ViewStateResult,
	WorkspaceLeaf,
	debounce,
	setIcon,
	requestUrl,
} from "obsidian";

type TitleSource = "youtube" | "markdown";
type Kind = "video" | "channel" | "playlist";

const CACHE_VERSION = 5;
const CACHE_MAX_AGE = 28 * 24 * 60 * 60 * 1000;
const isExpired = (savedAt: number | undefined): boolean => savedAt === undefined || Date.now() - savedAt > CACHE_MAX_AGE;

interface VideoInfo {
	at?: number;
	title: string;
	channel: string;
	channelUrl?: string;
	views?: number;
	duration?: string;
	durationSeconds?: number;
	published?: string;
	unavailable?: boolean;
	full: boolean;
	v: number;
}

interface ChannelInfo {
	at?: number;
	name: string;
	avatar: string;
	subscribers?: string;
	videos?: string;
	views?: number;
	v: number;
}

type ChannelLayout = "horizontal" | "vertical";
type VideoLayout = "horizontal" | "vertical";
type CardBackground = "transparent" | "padded" | "edge";

interface YouTubeGallerySettings {
	videoLinks: boolean;
	channelLinks: boolean;
	playlistLinks: boolean;
	playInObsidian: boolean;
	customNoteWidth: boolean;
	noteWidth: number;
	channelPage: boolean;
	autoplayNext: boolean;
	columns: number;
	channelColumns: number;
	cardBackground: CardBackground;
	videoLayout: VideoLayout;
	channelLayout: ChannelLayout;
	hoverZoom: boolean;
	hoverCard: boolean;
	marginTop: number;
	marginBottom: number;
	titleSize: number;
	titleLines: number;
	avatarSize: number;
	gapHorizontal: number;
	gapVertical: number;
	playerWidth: number;
	titleSource: TitleSource;
	showChannel: boolean;
	showChannelPicture: boolean;
	showSubscribers: boolean;
	showVideoCount: boolean;
	showViews: boolean;
	showDuration: boolean;
	showPublished: boolean;
	showTotalDuration: boolean;
	channelSorting: boolean;
	titleOnPaste: boolean;
	preloadImages: boolean;
	apiKey: string;
	cache: Record<string, VideoInfo>;
	channelCache: Record<string, ChannelInfo>;
	playlistCache: Record<string, PlaylistInfo>;
}

/** How far ahead of the visible area thumbnails start loading when preloading is on. */
const PRELOAD_MARGIN = 800;

/** The nearest ancestor that scrolls, which is what decides what is "in view" inside Obsidian. */
function scrollParent(el: HTMLElement): Element | null {
	for (let node = el.parentElement; node; node = node.parentElement) {
		const overflow = getComputedStyle(node).overflowY;
		if (overflow === "auto" || overflow === "scroll") return node;
	}
	return null;
}

const DEFAULT_SETTINGS: YouTubeGallerySettings = {
	videoLinks: true,
	channelLinks: true,
	playlistLinks: true,
	playInObsidian: true,
	customNoteWidth: false,
	noteWidth: 1000,
	channelPage: true,
	autoplayNext: false,
	columns: 3,
	channelColumns: 3,
	cardBackground: "transparent",
	videoLayout: "vertical",
	channelLayout: "horizontal",
	hoverZoom: true,
	hoverCard: true,
	marginTop: 16,
	marginBottom: 30,
	titleSize: 13,
	titleLines: 2,
	avatarSize: 16,
	gapHorizontal: 12,
	gapVertical: 20,
	playerWidth: 600,
	titleSource: "markdown",
	showChannel: true,
	showChannelPicture: true,
	showSubscribers: true,
	showVideoCount: true,
	showViews: false,
	showDuration: false,
	showPublished: false,
	showTotalDuration: false,
	channelSorting: false,
	titleOnPaste: true,
	preloadImages: true,
	apiKey: "",
	cache: {},
	channelCache: {},
	playlistCache: {},
};

interface LinkItem {
	href: string;
	label: string;
	videoId?: string;
	channel?: ChannelRef;
	playlistId?: string;
}

interface ChannelRef {
	url: string;
	key: string;
	handle?: string;
	id?: string;
	user?: string;
}

const VIDEO_ID = /^[\w-]{11}$/;
const YOUTUBE_HOSTS = new Set([
	"youtube.com",
	"www.youtube.com",
	"m.youtube.com",
	"music.youtube.com",
	"youtube-nocookie.com",
	"www.youtube-nocookie.com",
]);
const CHANNEL_SUBPAGES = new Set([
	"videos",
	"featured",
	"about",
	"streams",
	"shorts",
	"playlists",
	"community",
	"live",
	"releases",
]);
const FALLBACK_TITLE = "YouTube video";
const BLANK_TEXT = /^[\s​-‏ ⁠﻿]*$/;

function safeUrl(href: string): URL | null {
	try {
		const url = new URL(href);
		return url.protocol === "https:" || url.protocol === "http:" ? url : null;
	} catch {
		return null;
	}
}

function parseVideoId(href: string): string | null {
	const url = safeUrl(href);
	if (!url) return null;

	const host = url.hostname.toLowerCase();
	const parts = url.pathname.split("/").filter(Boolean);
	let id: string | null = null;

	if (host === "youtu.be" || host === "www.youtu.be") {
		id = parts[0] ?? null;
	} else if (YOUTUBE_HOSTS.has(host)) {
		if (parts[0] === "watch") id = url.searchParams.get("v");
		else if (["embed", "shorts", "live", "v"].includes(parts[0])) id = parts[1] ?? null;
	}
	return id && VIDEO_ID.test(id) ? id : null;
}

function parseChannel(href: string): ChannelRef | null {
	const url = safeUrl(href);
	if (!url || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;

	const parts = url.pathname.split("/").filter(Boolean);
	const first = parts[0];
	if (!first) return null;

	if (first.startsWith("@") && first.length > 1) {
		if (parts.length > 2 || (parts[1] && !CHANNEL_SUBPAGES.has(parts[1]))) return null;
		const handle = decodeURIComponent(first.slice(1));
		return {
			url: `https://www.youtube.com/@${encodeURIComponent(handle)}`,
			key: `@${handle.toLowerCase()}`,
			handle,
		};
	}

	if (["c", "user", "channel"].includes(first) && parts[1]) {
		if (parts.length > 3 || (parts[2] && !CHANNEL_SUBPAGES.has(parts[2]))) return null;
		const value = decodeURIComponent(parts[1]);
		const ref: ChannelRef = {
			url: `https://www.youtube.com/${first}/${encodeURIComponent(value)}`,
			key: first === "channel" ? `channel/${value}` : `${first}/${value.toLowerCase()}`,
		};
		if (first === "channel") ref.id = value;
		if (first === "user") ref.user = value;
		return ref;
	}
	return null;
}

function formatDuration(iso: string): string {
	const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
	if (!match) return "";
	const hours = Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0);
	const minutes = Number(match[3] ?? 0);
	const seconds = Number(match[4] ?? 0);
	if (hours + minutes + seconds === 0) return "";
	const ss = String(seconds).padStart(2, "0");
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

function parseDurationSeconds(iso: string): number | null {
	const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
	if (!match) return null;
	return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
}

function formatTotalDuration(total: number): string {
	const minutes = total > 0 ? Math.max(1, Math.round(total / 60)) : 0;
	return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function formatCount(count: number): string {
	return new Intl.NumberFormat(undefined, {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(count);
}

function formatAge(iso: string): string {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return "";
	const seconds = Math.round((then - Date.now()) / 1000);
	const units: [Intl.RelativeTimeFormatUnit, number][] = [
		["year", 31536000],
		["month", 2592000],
		["week", 604800],
		["day", 86400],
		["hour", 3600],
		["minute", 60],
	];
	const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	for (const [unit, size] of units) {
		if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
	}
	return format.format(0, "second");
}

interface PlaylistVideo {
	id: string;
	title: string;
	channel?: string;
}
type PlaylistNext =
	| { source: "api"; token: string }
	| { source: "page"; token: string; key: string; version: string };
interface PlaylistInfo {
	title: string;
	description: string;
	channel: string;
	channelUrl?: string;
	videoCount?: number;
	views?: string;
	totalSeconds?: number;
	videos: PlaylistVideo[];
	next?: PlaylistNext;
	fetched: number;
	v: number;
}
type PlaylistPart = Partial<Omit<PlaylistInfo, "fetched" | "v">>;

const FALLBACK_PLAYLIST = "YouTube playlist";
const PLAYLIST_TTL = 12 * 60 * 60 * 1000;
const PLAYLIST_PAGE = 50;

function parsePlaylistId(href: string): string | null {
	const url = safeUrl(href);
	if (!url || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
	if (url.pathname.replace(/\/+$/, "") !== "/playlist") return null;
	const id = url.searchParams.get("list");
	return id && /^[\w-]{10,64}$/.test(id) ? id : null;
}

function extractInitialData(html: string): unknown {
	const marker = "var ytInitialData = ";
	const start = html.indexOf(marker);
	if (start < 0) return null;
	const from = start + marker.length;
	const end = html.indexOf(";</script>", from);
	if (end < 0) return null;
	try {
		return JSON.parse(html.slice(from, end));
	} catch {
		return null;
	}
}

function findAll(node: unknown, key: string, out: unknown[] = []): unknown[] {
	if (!node || typeof node !== "object") return out;
	for (const [name, value] of Object.entries(node)) {
		if (name === key) out.push(value);
		findAll(value, key, out);
	}
	return out;
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	const node = value as { simpleText?: string; runs?: { text?: string }[] } | null;
	if (typeof node?.simpleText === "string") return node.simpleText;
	return Array.isArray(node?.runs) ? node.runs.map((run) => run.text ?? "").join("") : "";
}

function flattenText(node: unknown, out: string[] = []): string[] {
	if (!node || typeof node !== "object") return out;
	const known = node as { runs?: unknown; simpleText?: unknown; content?: unknown };
	if (Array.isArray(known.runs) || typeof known.simpleText === "string") {
		out.push(textOf(node));
		return out;
	}
	if (typeof known.content === "string") {
		out.push(known.content);
		return out;
	}
	for (const value of Object.values(node)) flattenText(value, out);
	return out;
}

function extractPlaylistVideos(root: unknown): PlaylistVideo[] {
	const videos: PlaylistVideo[] = [];
	for (const entry of findAll(root, "playlistVideoRenderer") as Record<string, unknown>[]) {
		const id = String(entry.videoId ?? "");
		if (!VIDEO_ID.test(id) || entry.isPlayable === false) continue;
		videos.push({ id, title: textOf(entry.title), channel: textOf(entry.shortBylineText) || undefined });
	}
	return videos;
}

function continuationToken(root: unknown): string | undefined {
	const token = (findAll(root, "continuationCommand")[0] as { token?: unknown } | undefined)?.token;
	return typeof token === "string" ? token : undefined;
}

function parsePlaylistApiItems(items: unknown): PlaylistVideo[] {
	const videos: PlaylistVideo[] = [];
	for (const entry of Array.isArray(items) ? items : []) {
		const id = String(entry?.snippet?.resourceId?.videoId ?? "");
		const title = String(entry?.snippet?.title ?? "");
		if (!VIDEO_ID.test(id) || /^(Private|Deleted) video$/.test(title)) continue;
		videos.push({ id, title, channel: entry?.snippet?.videoOwnerChannelTitle ? String(entry.snippet.videoOwnerChannelTitle) : undefined });
	}
	return videos;
}

const UNAVAILABLE_INFO: VideoInfo = { title: "", channel: "", full: false, unavailable: true, v: CACHE_VERSION };

function decodeEntities(text: string): string {
	return text
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function metaContent(html: string, property: string): string | null {
	const match = new RegExp(`<meta property="${property}" content="([^"]*)"`, "i").exec(html);
	return match ? decodeEntities(match[1]) : null;
}

type StatKind = "views" | "subscribers" | "videos" | "duration";

const STAT_ICONS: Record<StatKind, string> = {
	views: "eye",
	subscribers: "users",
	videos: "video",
	duration: "clock",
};

function renderStat(parent: HTMLElement, kind: StatKind, value: string): void {
	const stat = parent.createSpan({ cls: "ytg-stat" });
	setIcon(stat.createSpan({ cls: "ytg-stat-icon" }), STAT_ICONS[kind]);
	stat.createSpan({ text: value });
}

type BareKind = "video" | "channel";

const BARE_LINE = /^(\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[.\]\s+)?)(https?:\/\/[^\s<>]+)\s*$/;

function classifyBare(href: string): BareKind | null {
	if (parseVideoId(href)) return "video";
	if (parseChannel(href)) return "channel";
	return null;
}

function mapBodyLines(text: string, edit: (line: string) => string | null): string {
	const lines = text.split("\n");
	let inFrontMatter = lines[0]?.trim() === "---";
	let fence: string | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		if (inFrontMatter) {
			if (i > 0 && (trimmed === "---" || trimmed === "...")) inFrontMatter = false;
			continue;
		}
		const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
		if (fence) {
			if (fenceMatch && fenceMatch[1].startsWith(fence)) fence = null;
			continue;
		}
		if (fenceMatch) {
			fence = fenceMatch[1];
			continue;
		}

		const out = edit(line);
		if (out !== null) lines[i] = out;
	}
	return lines.join("\n");
}

function mapBareLines(text: string, visit: (url: string, kind: BareKind) => string | null): string {
	return mapBodyLines(text, (line) => {
		const match = BARE_LINE.exec(line);
		if (!match) return null;
		const kind = classifyBare(match[2]);
		if (!kind) return null;
		const link = visit(match[2], kind);
		return link ? match[1] + link + (line.endsWith("\r") ? "\r" : "") : null;
	});
}

function markdownLink(title: string, url: string): string {
	const label = title.replace(/\s+/g, " ").trim().replace(/([[\]])/g, "\\$1");
	const target = url.replace(/\(/g, "%28").replace(/\)/g, "%29");
	return `[${label}](${target})`;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

interface BareScan {
	files: TFile[];
	videos: number;
	channels: number;
	urls: Map<string, BareKind>;
}

const VIDEO_URL = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?|youtu\.be\/)[^\s)<>\]"']+/gi;

function shortenVideoUrl(raw: string): string | null {
	const url = safeUrl(raw);
	if (!url) return null;
	const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
	const parts = url.pathname.split("/").filter(Boolean);

	let id: string | null = null;
	if (host === "youtu.be" && parts.length === 1) id = parts[0];
	else if (host === "youtube.com" && parts.length === 1 && parts[0] === "watch") id = url.searchParams.get("v");
	if (!id || !VIDEO_ID.test(id)) return null;

	if (url.searchParams.has("list")) return null;

	const time = url.searchParams.get("t") ?? url.searchParams.get("start");
	const short = `https://youtu.be/${id}${time && /^[0-9hms]+$/i.test(time) ? `?t=${time}` : ""}`;
	return short === raw ? null : short;
}

function shortenVideoLinks(text: string, counter: { count: number }): string {
	return mapBodyLines(text, (line) => {
		if (!line.includes("youtu")) return null;
		let changed = false;
		const out = line
			.split(/(`+[^`]*`+)/)
			.map((segment, index) =>
				index % 2
					? segment
					: segment.replace(VIDEO_URL, (match) => {
							const trail = /[.,;:!?]+$/.exec(match)?.[0] ?? "";
							const short = shortenVideoUrl(trail ? match.slice(0, -trail.length) : match);
							if (!short) return match;
							changed = true;
							counter.count++;
							return short + trail;
						}),
			)
			.join("");
		return changed ? out : null;
	});
}

interface ShortenScan {
	files: TFile[];
	links: number;
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly paragraphs: string[],
		private readonly confirmText: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(this.heading);
		for (const text of this.paragraphs) contentEl.createEl("p", { text });
		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(this.confirmText)
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

interface QueueEntry {
	id: string;
	href: string;
	el: HTMLElement;
}
interface VideoQueue {
	items: QueueEntry[];
	loadMore?: () => Promise<boolean>;
}

function parseStartSeconds(href: string): number {
	const raw = safeUrl(href)?.searchParams.get("t") ?? safeUrl(href)?.searchParams.get("start") ?? "";
	const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i.exec(raw);
	if (!match) return 0;
	return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

const VIEW_CHANNEL = "youtube-gallery-channel";
type ChannelSort = "recent" | "oldest" | "popular";
interface ChannelFeed {
	done: boolean;
	next(): Promise<PlaylistVideo[]>;
}

function extractChannelVideos(root: unknown): PlaylistVideo[] {
	const videos: PlaylistVideo[] = [];
	const seen = new Set<string>();
	const add = (id: string, title: string, channel?: string): void => {
		if (!VIDEO_ID.test(id) || seen.has(id)) return;
		seen.add(id);
		videos.push({ id, title, channel });
	};
	for (const entry of findAll(root, "videoRenderer") as Record<string, unknown>[]) {
		add(String(entry.videoId ?? ""), textOf(entry.title));
	}
	for (const entry of findAll(root, "lockupViewModel") as {
		contentId?: unknown;
		contentType?: unknown;
		metadata?: { lockupMetadataViewModel?: { title?: { content?: unknown } } };
	}[]) {
		if (entry.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") continue;
		add(String(entry.contentId ?? ""), String(entry.metadata?.lockupMetadataViewModel?.title?.content ?? ""));
	}
	return videos;
}

const SORTS: { sort: ChannelSort; icon: string; label: string }[] = [
	{ sort: "recent", icon: "clock", label: "Newest" },
	{ sort: "oldest", icon: "history", label: "Oldest" },
	{ sort: "popular", icon: "flame", label: "Most popular" },
];

class ChannelView extends ItemView {
	private ref: ChannelRef | null = null;
	private sort: ChannelSort = "recent";
	private titleText = "Channel";
	private body: HTMLElement | null = null;
	private sortButtons = new Map<ChannelSort, HTMLElement>();
	private run = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: YouTubeGalleryPlugin,
	) {
		super(leaf);
	}

	get refKey(): string | null {
		return this.ref?.key ?? null;
	}

	getViewType(): string {
		return VIEW_CHANNEL;
	}

	getDisplayText(): string {
		return this.titleText;
	}

	getIcon(): string {
		return "tv";
	}

	getState(): Record<string, unknown> {
		return { ref: this.ref, sort: this.sort };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const saved = state as { ref?: ChannelRef; sort?: ChannelSort } | null;
		if (saved?.ref?.key) {
			this.ref = saved.ref;
			this.sort = SORTS.some((entry) => entry.sort === saved.sort) ? (saved.sort as ChannelSort) : "recent";
			this.build(saved.ref);
		}
		await super.setState(state, result);
	}

	async onClose(): Promise<void> {
		this.run++;
	}

	rebuild(): void {
		if (this.ref) this.build(this.ref);
	}

	private setTitle(text: string): void {
		this.titleText = text;
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
	}

	private build(ref: ChannelRef): void {
		const root = this.contentEl;
		root.empty();
		const page = root.createDiv({ cls: "ytg-channel-page" });
		this.setTitle(ref.handle ? `@${ref.handle}` : ref.key);

		const header = page.createDiv({ cls: "ytg-cp-header" });
		const avatar = this.plugin.createAvatar(header, true);
		const info = header.createDiv({ cls: "ytg-cp-info" });
		const nameEl = info.createDiv({ cls: "ytg-cp-name", text: ref.handle ? `@${ref.handle}` : ref.key });
		const statsEl = info.createDiv({ cls: "ytg-channel-stats" });

		const open = this.makeButton(header, "arrow-up-right", "Open in browser");
		open.addEventListener("click", () => window.open(ref.url, "_blank"));

		this.sortButtons.clear();
		if (this.plugin.channelSortingEnabled()) {
			const bar = page.createDiv({ cls: "ytg-cp-sort" });
			for (const entry of SORTS) {
				const button = this.makeButton(bar, entry.icon, entry.label);
				button.addEventListener("click", () => {
					if (this.sort === entry.sort) return;
					this.sort = entry.sort;
					this.app.workspace.requestSaveLayout();
					this.markSort();
					void this.loadVideos(ref);
				});
				this.sortButtons.set(entry.sort, button);
			}
			this.markSort();
		} else {
			this.sort = "recent";
		}

		this.body = page.createDiv();

		void this.plugin.getChannelInfo(ref).then((channel) => {
			if (!channel) return;
			if (channel.name) {
				nameEl.setText(channel.name);
				this.setTitle(channel.name);
			}
			if (channel.avatar) {
				avatar.img.src = channel.avatar;
				avatar.img.show();
			}
			const { showSubscribers, showVideoCount } = this.plugin.settings;
			const stats: { kind: StatKind; value: string }[] = [];
			if (showSubscribers && channel.subscribers) stats.push({ kind: "subscribers", value: channel.subscribers });
			if (showVideoCount && channel.videos) stats.push({ kind: "videos", value: channel.videos });
			if (channel.views !== undefined) stats.push({ kind: "views", value: new Intl.NumberFormat().format(channel.views) });
			statsEl.empty();
			statsEl.toggleClass("ytg-stats-icons", stats.length > 0);
			for (const stat of stats) renderStat(statsEl, stat.kind, stat.value);
		});

		void this.loadVideos(ref);
	}

	private makeButton(parent: HTMLElement, icon: string, label: string): HTMLElement {
		const button = parent.createEl("button", { cls: "ytg-cp-btn" });
		setIcon(button.createSpan({ cls: "ytg-cp-btn-icon" }), icon);
		button.createSpan({ text: label });
		return button;
	}

	private markSort(): void {
		for (const [sort, button] of this.sortButtons) button.toggleClass("is-active", sort === this.sort);
	}

	private async loadVideos(ref: ChannelRef): Promise<void> {
		const body = this.body;
		if (!body) return;
		const run = ++this.run;
		body.empty();
		const gallery = body.createDiv({ cls: "ytg-gallery ytg-videos" });
		const queue: VideoQueue = { items: [] };
		const status = body.createDiv({ cls: "ytg-cp-status", text: "Loading…" });
		const footer = body.createDiv();

		const feed = await this.plugin.openChannelFeed(ref, this.sort);
		const known = new Set<string>();
		const loadBatch = async (): Promise<boolean> => {
			const batch = (await feed.next()).filter((video) => !known.has(video.id));
			if (run !== this.run) return false;
			for (const video of batch) {
				known.add(video.id);
				const item: LinkItem = { href: `https://youtu.be/${video.id}`, label: video.title, videoId: video.id };
				this.plugin.renderVideo(gallery, item, video.id, { channel: video.channel }, queue);
			}
			return batch.length > 0;
		};

		await loadBatch();
		if (run !== this.run) return;
		status.remove();
		if (known.size === 0) {
			footer.createDiv({
				cls: "ytg-cp-status",
				text: this.sort === "recent" ? "No videos found." : "Could not load videos in this order. A YouTube Data API key makes it reliable.",
			});
			return;
		}

		queue.loadMore = async (): Promise<boolean> => !feed.done && (await loadBatch());
		const syncButton = (): void => {
			footer.empty();
			if (feed.done) return;
			const more = footer.createEl("button", { cls: "ytg-playlist-more", text: "Load more" });
			more.addEventListener("click", async () => {
				more.disabled = true;
				await loadBatch();
				if (run === this.run) syncButton();
			});
		};
		syncButton();
	}
}

export default class YouTubeGalleryPlugin extends Plugin {
	settings: YouTubeGallerySettings = { ...DEFAULT_SETTINGS, cache: {}, channelCache: {}, playlistCache: {} };

	private pendingVideos = new Map<string, Promise<VideoInfo | null>>();
	private pendingChannels = new Map<string, Promise<ChannelInfo | null>>();
	private pendingPlaylists = new Map<string, Promise<PlaylistInfo | null>>();
	private player: {
		el: HTMLElement;
		frame: HTMLElement;
		href: string;
		onResize: () => void;
		onMessage: (evt: MessageEvent) => void;
		autoplayButton: HTMLElement;
		queue?: VideoQueue;
		entry?: QueueEntry;
		ended: boolean;
	} | null = null;
	private failed = new Set<string>();
	private unavailable = new Set<string>();
	private apiBroken = false;
	private persistSoon = debounce(() => void this.saveSettings(), 2000, true);

	async onload(): Promise<void> {
		await this.loadSettings();
		this.refresh(false);

		this.addSettingTab(new YouTubeGallerySettingTab(this.app, this));
		this.registerMarkdownPostProcessor((el) => this.processSection(el));
		this.registerView(VIEW_CHANNEL, (leaf) => new ChannelView(leaf, this));

		this.registerEvent(this.app.workspace.on("editor-paste", (evt, editor) => this.handlePaste(evt, editor)));

		this.app.workspace.onLayoutReady(() => this.refresh(true));
	}

	onunload(): void {
		this.closePlayer();
		for (const observer of this.observers) observer.disconnect();
		this.observers.clear();
		this.observerMap = new WeakMap();
		this.persistSoon.run();
		document.body.classList.remove("ytg-zoom", "ytg-hovercard", "ytg-filled", "ytg-edge");
		for (const name of ["--ytg-columns", "--ytg-channel-columns", "--ytg-channel-scale", "--ytg-mt", "--ytg-mb", "--ytg-title-size", "--ytg-title-lines", "--ytg-avatar-size", "--ytg-hgap", "--ytg-vgap", "--ytg-player-width", "--file-line-width"]) {
			document.body.style.removeProperty(name);
		}
		document.querySelectorAll(".ytg-gallery").forEach((el) => el.remove());
		document.querySelectorAll(".ytg-source").forEach((el) => el.classList.remove("ytg-source"));
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<YouTubeGallerySettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...data,
			cache: { ...(data?.cache ?? {}) },
			channelCache: { ...(data?.channelCache ?? {}) },
			playlistCache: { ...(data?.playlistCache ?? {}) },
		};
		const clamp = (value: number, min: number, max: number, fallback: number): number =>
			Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
		const s = this.settings;
		s.columns = clamp(s.columns, 1, 4, 3);
		s.channelColumns = clamp(s.channelColumns, 1, 4, 3);
		if ((s.cardBackground as string) === "filled") s.cardBackground = "padded";
		if (s.cardBackground !== "padded" && s.cardBackground !== "edge") s.cardBackground = "transparent";
		if (s.videoLayout !== "horizontal") s.videoLayout = "vertical";
		if (s.channelLayout !== "vertical") s.channelLayout = "horizontal";
		// First run on a phone: 2 per row instead of the desktop 3 (nothing was saved yet).
		if (Platform.isMobile) {
			if (data?.columns === undefined) s.columns = 2;
			if (data?.channelColumns === undefined) s.channelColumns = 2;
		}
		// The separate "on mobile app" settings no longer exist: drop what older versions saved.
		for (const key of ["mobileVideoLayout", "mobileChannelLayout", "mobileColumns", "mobileChannelColumns"]) {
			delete (s as unknown as Record<string, unknown>)[key];
		}
		s.marginTop = clamp(s.marginTop, 0, 64, 16);
		s.marginBottom = clamp(s.marginBottom, 0, 64, 30);
		s.titleSize = clamp(s.titleSize, 10, 22, 13);
		s.titleLines = s.titleLines === 1 || s.titleLines === 0 ? s.titleLines : 2;
		s.avatarSize = clamp(s.avatarSize, 10, 48, 16);
		s.gapHorizontal = clamp(s.gapHorizontal, 0, 48, 12);
		s.gapVertical = clamp(s.gapVertical, 0, 64, 20);
		s.playerWidth = clamp(s.playerWidth, 320, 1280, 600);
		s.noteWidth = clamp(s.noteWidth, 500, 2000, 1000);

		let removed = 0;
		for (const store of [s.cache, s.channelCache] as Record<string, { at?: number }>[]) {
			for (const key of Object.keys(store)) {
				if (isExpired(store[key]?.at)) {
					delete store[key];
					removed++;
				}
			}
		}
		for (const key of Object.keys(s.playlistCache)) {
			if (isExpired(s.playlistCache[key]?.fetched)) {
				delete s.playlistCache[key];
				removed++;
			}
		}
		if (removed > 0) this.persistSoon();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	kindActive(kind: Kind): boolean {
		if (kind === "video") return this.settings.videoLinks;
		return kind === "channel" ? this.settings.channelLinks : this.settings.playlistLinks;
	}

	refresh(rerender: boolean): void {
		const s = this.settings;
		const body = document.body;
		body.classList.toggle("ytg-zoom", s.hoverZoom);
		body.classList.toggle("ytg-hovercard", s.hoverCard);
		body.classList.toggle("ytg-filled", s.cardBackground !== "transparent");
		body.classList.toggle("ytg-edge", s.cardBackground === "edge");
		const mobile = Platform.isMobile;
		// Same settings on every device; a phone just never goes past 3 per row, and wide (horizontal) cards take a full row.
		const videoLayout = s.videoLayout;
		const channelLayout = s.channelLayout;
		const columns = mobile ? (videoLayout === "horizontal" ? 1 : Math.min(s.columns, 3)) : s.columns;
		const channelColumns = mobile ? (channelLayout === "horizontal" ? 1 : Math.min(s.channelColumns, 3)) : s.channelColumns;
		body.classList.toggle("ytg-videos-horizontal", videoLayout === "horizontal");
		body.classList.toggle("ytg-channels-vertical", channelLayout === "vertical");
		body.style.setProperty("--ytg-columns", String(columns));
		body.style.setProperty("--ytg-channel-columns", String(channelColumns));
		const scales = mobile ? [0, 1.1, 1, 0.9] : [0, 1.7, 1.35, 1, 0.9];
		body.style.setProperty("--ytg-channel-scale", String(scales[channelColumns]));
		body.style.setProperty("--ytg-mt", `${s.marginTop}px`);
		body.style.setProperty("--ytg-mb", `${s.marginBottom}px`);
		body.style.setProperty("--ytg-title-size", `${s.titleSize}px`);
		body.style.setProperty("--ytg-title-lines", s.titleLines > 0 ? String(s.titleLines) : "none");
		body.style.setProperty("--ytg-avatar-size", `${s.avatarSize}px`);
		body.style.setProperty("--ytg-hgap", `${s.gapHorizontal}px`);
		body.style.setProperty("--ytg-vgap", `${s.gapVertical}px`);
		body.style.setProperty("--ytg-player-width", `${s.playerWidth}px`);
		if (s.customNoteWidth && !mobile) body.style.setProperty("--file-line-width", `${s.noteWidth}px`);
		else body.style.removeProperty("--file-line-width");
		if (rerender) this.rerenderViews();
	}

	resetApiState(): void {
		this.apiBroken = false;
		this.failed.clear();
		this.unavailable.clear();
	}

	async clearCache(): Promise<void> {
		this.settings.cache = {};
		this.settings.channelCache = {};
		this.settings.playlistCache = {};
		this.resetApiState();
		await this.saveSettings();
		this.rerenderViews();
	}

	private handlePaste(evt: ClipboardEvent, editor: Editor): void {
		if (!this.settings.titleOnPaste || evt.defaultPrevented || editor.somethingSelected()) return;
		const text = evt.clipboardData?.getData("text/plain").trim() ?? "";
		if (!/^https?:\/\/\S+$/.test(text)) return;
		const kind = classifyBare(text);
		if (!kind) return;

		const cursor = editor.getCursor();
		if (/(\]\(|<|\[)$/.test(editor.getLine(cursor.line).slice(0, cursor.ch))) return;
		let fences = 0;
		for (let n = 0; n < cursor.line; n++) {
			if (/^\s*(```|~~~)/.test(editor.getLine(n))) fences++;
		}
		if (fences % 2 === 1) return;

		evt.preventDefault();
		editor.replaceSelection(text);
		const from = cursor;
		const to = editor.getCursor();
		void this.fetchBareTitle(text, kind).then((title) => {
			if (!title || editor.getRange(from, to) !== text) return;
			const atEnd = editor.getCursor().line === to.line && editor.getCursor().ch === to.ch;
			const link = markdownLink(title, text);
			editor.replaceRange(link, from, to);
			if (atEnd) editor.setCursor(editor.offsetToPos(editor.posToOffset(from) + link.length));
		});
	}

	private async copyText(text: string, done: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			new Notice(done);
		} catch {
			new Notice("Could not copy.");
		}
	}

	private attachMenu(link: HTMLAnchorElement, href: string, videoId: string | undefined, getText: () => string, play?: () => void, openChannel?: () => void): void {
		link.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			const menu = new Menu();
			menu.addItem((item) =>
				item.setTitle("Open in browser").setIcon("external-link").onClick(() => window.open(href, "_blank")),
			);
			if (videoId) {
				menu.addItem((item) =>
					item
						.setTitle("Play in Obsidian")
						.setIcon("play")
						.onClick(() => (play ? play() : this.playVideo(videoId, href))),
				);
			}
			const channelInfo = videoId ? this.settings.cache[videoId] : undefined;
			if (channelInfo?.channel && channelInfo.channelUrl) {
				const channelUrl = channelInfo.channelUrl;
				menu.addItem((item) => {
					const ref = parseChannel(channelUrl);
					item.setTitle(channelInfo.channel)
						.setIcon("user")
						.onClick(() => (ref && this.settings.channelPage ? void this.openChannelView(ref) : window.open(channelUrl, "_blank")));
					const icon = (item as unknown as { dom?: HTMLElement }).dom?.querySelector<HTMLElement>(".menu-item-icon");
					if (!icon || !ref) return;
					const show = (src: string): void => {
						icon.empty();
						icon.createEl("img", { cls: "ytg-menu-avatar", attr: { src, alt: "" } });
					};
					const known = this.settings.channelCache[ref.key]?.avatar;
					if (known) show(known);
					else void this.getChannelInfo(ref).then((channel) => channel?.avatar && show(channel.avatar));
				});
			}
			if (openChannel) {
				menu.addItem((item) => item.setTitle("Open in Obsidian").setIcon("tv").onClick(openChannel));
			}
			menu.addSeparator();
			menu.addItem((item) =>
				item.setTitle("Copy link").setIcon("link").onClick(() => void this.copyText(href, "Link copied.")),
			);
			menu.addItem((item) =>
				item
					.setTitle(videoId ? "Copy title" : "Copy name")
					.setIcon("copy")
					.onClick(() => void this.copyText(getText(), videoId ? "Title copied." : "Name copied.")),
			);
			menu.showAtMouseEvent(evt);
		});
	}

	async scanBareLinks(): Promise<BareScan> {
		const scan: BareScan = { files: [], videos: 0, channels: 0, urls: new Map() };
		for (const file of this.app.vault.getMarkdownFiles()) {
			const text = await this.app.vault.cachedRead(file);
			let found = false;
			mapBareLines(text, (url, kind) => {
				found = true;
				if (kind === "video") scan.videos++;
				else scan.channels++;
				scan.urls.set(url, kind);
				return null;
			});
			if (found) scan.files.push(file);
		}
		return scan;
	}

	async offerBareLinkConversion(): Promise<void> {
		const scan = await this.scanBareLinks();
		if (scan.urls.size === 0) {
			new Notice("No YouTube links without a title found.");
			return;
		}
		new ConfirmModal(
			this.app,
			"Add titles to links",
			[
				`Found ${plural(scan.videos, "video link")} and ${plural(scan.channels, "channel link")} ` +
					`without a title in ${plural(scan.files.length, "note")}.`,
				"Each one becomes a Markdown link with its YouTube title. Nothing is removed. Consider backing up your vault first.",
			],
			"Add titles",
			() => void this.convertBareLinks(scan),
		).open();
	}

	private async fetchBareTitle(url: string, kind: BareKind): Promise<string | null> {
		if (kind === "video") {
			const id = parseVideoId(url);
			return id ? ((await this.getVideoInfo(id))?.title ?? null) : null;
		}
		const ref = parseChannel(url);
		return ref ? ((await this.getChannelInfo(ref))?.name ?? null) : null;
	}

	private async convertBareLinks(scan: BareScan): Promise<void> {
		const progress = new Notice("Fetching titles…", 0);
		const titles = new Map<string, string>();
		const queue = [...scan.urls];
		let done = 0;

		const worker = async (): Promise<void> => {
			for (let next = queue.shift(); next; next = queue.shift()) {
				const [url, kind] = next;
				const title = await this.fetchBareTitle(url, kind);
				if (title) titles.set(url, title);
				done++;
				progress.setMessage(`Fetching titles… ${done}/${scan.urls.size}`);
			}
		};
		await Promise.all([worker(), worker(), worker(), worker()]);

		let videos = 0;
		let channels = 0;
		for (const file of scan.files) {
			try {
				await this.app.vault.process(file, (data) =>
					mapBareLines(data, (url, kind) => {
						const title = titles.get(url);
						if (!title) return null;
						if (kind === "video") videos++;
						else channels++;
						return markdownLink(title, url);
					}),
				);
			} catch {
			}
		}

		progress.hide();
		const failed = scan.urls.size - titles.size;
		new Notice(
			`Updated ${plural(videos, "video link")} and ${plural(channels, "channel link")}.` +
				(failed > 0 ? ` ${plural(failed, "link")} could not be fetched and ${failed === 1 ? "was" : "were"} left as is.` : ""),
		);
	}

	async scanLongVideoLinks(): Promise<ShortenScan> {
		const scan: ShortenScan = { files: [], links: 0 };
		for (const file of this.app.vault.getMarkdownFiles()) {
			const counter = { count: 0 };
			shortenVideoLinks(await this.app.vault.cachedRead(file), counter);
			if (counter.count > 0) {
				scan.files.push(file);
				scan.links += counter.count;
			}
		}
		return scan;
	}

	async offerLinkShortening(): Promise<void> {
		const scan = await this.scanLongVideoLinks();
		if (scan.links === 0) {
			new Notice("No video links to shorten found.");
			return;
		}
		new ConfirmModal(
			this.app,
			"Shorten video links",
			[
				`Found ${plural(scan.links, "video link")} that can be shortened in ${plural(scan.files.length, "note")}.`,
				"Each one becomes youtu.be/ID. Titles, channel links and start times are kept, and nothing is removed. Consider backing up your vault first.",
			],
			"Shorten links",
			() => void this.shortenLinks(scan),
		).open();
	}

	private async shortenLinks(scan: ShortenScan): Promise<void> {
		const counter = { count: 0 };
		for (const file of scan.files) {
			try {
				await this.app.vault.process(file, (data) => shortenVideoLinks(data, counter));
			} catch {
			}
		}
		new Notice(`Shortened ${plural(counter.count, "video link")}.`);
	}

	async testApiKey(): Promise<void> {
		const key = this.settings.apiKey.trim();
		if (!key) {
			new Notice("YouTube Gallery: paste an API key first.");
			return;
		}
		try {
			const res = await requestUrl({
				url:
					"https://www.googleapis.com/youtube/v3/videos?part=snippet&id=dQw4w9WgXcQ" +
					`&key=${encodeURIComponent(key)}`,
				throw: false,
			});
			if (res.status === 200) {
				this.resetApiState();
				new Notice("YouTube Gallery: the API key works.");
			} else {
				const reason = String(res.json?.error?.message ?? `HTTP ${res.status}`);
				new Notice(`YouTube Gallery: the API key was rejected. ${reason}`, 10000);
			}
		} catch {
			new Notice("YouTube Gallery: could not reach YouTube. Check your connection.");
		}
	}

	channelSortingEnabled(): boolean {
		return this.settings.channelSorting && this.hasApiKey();
	}

	private rerenderViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView) leaf.view.previewMode.rerender(true);
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_CHANNEL)) {
			if (leaf.view instanceof ChannelView) leaf.view.rebuild();
		}
	}

	private processSection(el: HTMLElement): void {
		if (!this.kindActive("video") && !this.kindActive("channel") && !this.kindActive("playlist")) return;

		const paragraphs = el.matches("p") ? [el] : Array.from(el.querySelectorAll("p"));

		for (const paragraph of paragraphs) {
			if (!paragraph.parentElement) continue;
			if (paragraph.closest("li, blockquote, table, .callout")) continue;
			this.processParagraph(paragraph);
		}

		const lists = el.matches("ul, ol") ? [el] : Array.from(el.querySelectorAll<HTMLElement>("ul, ol"));
		for (const list of lists) {
			if (!list.parentElement || list.closest(".ytg-source, blockquote, table, .callout")) continue;
			this.processList(list);
		}
	}

	private kindOfHref(href: string): Kind | null {
		if (this.kindActive("video") && parseVideoId(href)) return "video";
		if (this.kindActive("channel") && parseChannel(href)) return "channel";
		if (this.kindActive("playlist") && parsePlaylistId(href)) return "playlist";
		return null;
	}

	private toLinkItem(href: string, label: string): LinkItem {
		return {
			href,
			label: /^https?:\/\//i.test(label) ? "" : label,
			videoId: parseVideoId(href) ?? undefined,
			channel: parseChannel(href) ?? undefined,
			playlistId: parsePlaylistId(href) ?? undefined,
		};
	}

	private listItemLink(li: HTMLElement): { kind: Kind; anchor: HTMLAnchorElement } | null {
		if (li.matches(".ytg-source, .ytg-list-gallery")) return null;
		const decoration = ".list-bullet, .list-collapse-indicator, .collapse-indicator";
		const content = (node: ChildNode): ChildNode[] =>
			Array.from(node.childNodes).filter(
				(n) => !this.isBlank(n) && !(n instanceof HTMLElement && n.matches(decoration)),
			);

		let nodes = content(li);
		if (nodes.length === 1 && nodes[0].nodeName === "P") nodes = content(nodes[0]);
		if (nodes.length !== 1) return null;
		const kind = this.classify(nodes[0]);
		return kind ? { kind, anchor: nodes[0] as HTMLAnchorElement } : null;
	}

	private processList(list: HTMLElement): void {
		const entries = Array.from(list.children).filter((child): child is HTMLElement => child.tagName === "LI");
		let i = 0;
		while (i < entries.length) {
			const head = this.listItemLink(entries[i]);
			if (!head) {
				i++;
				continue;
			}
			const run: HTMLElement[] = [entries[i]];
			const anchors: HTMLAnchorElement[] = [head.anchor];
			let end = i + 1;
			for (; end < entries.length; end++) {
				const next = this.listItemLink(entries[end]);
				if (!next || next.kind !== head.kind) break;
				run.push(entries[end]);
				anchors.push(next.anchor);
			}
			i = end;

			const items = anchors.map((anchor) =>
				this.toLinkItem(anchor.getAttribute("href") ?? "", anchor.textContent?.trim() ?? ""),
			);
			const gallery = this.buildGallery(head.kind, items);
			if (run.length === entries.length) {
				list.before(gallery);
				list.addClass("ytg-source");
			} else {
				const holder = createEl("li", { cls: "ytg-list-gallery" });
				holder.append(gallery);
				run[0].before(holder);
				for (const li of run) li.addClass("ytg-source");
			}
		}
	}

	private classify(node: Node): Kind | null {
		if (node.nodeName !== "A") return null;
		return this.kindOfHref((node as HTMLAnchorElement).getAttribute("href") ?? "");
	}

	private isBlank(node: Node): boolean {
		return (
			node.nodeName === "BR" ||
			(node.nodeType === Node.TEXT_NODE && BLANK_TEXT.test(node.textContent ?? ""))
		);
	}

	private processParagraph(paragraph: HTMLElement): void {
		const nodes = Array.from(paragraph.childNodes);
		let i = 0;
		while (i < nodes.length) {
			const kind = this.classify(nodes[i]);
			if (!kind) {
				i++;
				continue;
			}

			const run: ChildNode[] = [];
			const anchors: HTMLAnchorElement[] = [];
			let end = i;
			while (end < nodes.length) {
				const node = nodes[end];
				const nodeKind = this.classify(node);
				if (nodeKind === kind) anchors.push(node as HTMLAnchorElement);
				else if (nodeKind !== null || !this.isBlank(node)) break;
				run.push(node);
				end++;
			}
			i = end;

			const items: LinkItem[] = anchors.map((anchor) => {
				const href = anchor.getAttribute("href") ?? "";
				const text = anchor.textContent?.trim() ?? "";
				return {
					href,
					label: /^https?:\/\//i.test(text) ? "" : text,
					videoId: parseVideoId(href) ?? undefined,
					channel: parseChannel(href) ?? undefined,
					playlistId: parsePlaylistId(href) ?? undefined,
				};
			});

			const source = createSpan({ cls: "ytg-source" });
			run[0].before(source);
			source.append(...run);
			source.before(this.buildGallery(kind, items));
		}
	}

	private buildGallery(kind: Kind, items: LinkItem[]): HTMLElement {
		if (kind === "playlist") {
			const list = createDiv({ cls: "ytg-playlists" });
			for (const item of items) if (item.playlistId) this.renderPlaylist(list, item, item.playlistId);
			return list;
		}
		const gallery = createDiv({
			cls: ["ytg-gallery", kind === "video" ? "ytg-videos" : "ytg-channels"],
		});
		const queue: VideoQueue = { items: [] };
		for (const item of items) {
			if (kind === "video" && item.videoId) this.renderVideo(gallery, item, item.videoId, undefined, queue);
			else if (kind === "channel" && item.channel) this.renderChannel(gallery, item, item.channel);
		}
		if (kind === "video" && items.length > 1 && this.settings.showTotalDuration && this.hasApiKey()) {
			this.addGalleryTotal(gallery, items.flatMap((item) => (item.videoId ? [item.videoId] : [])));
		}
		return gallery;
	}

	private playerIframe(frame: HTMLElement, id: string, href: string): void {
		const params = new URLSearchParams({ autoplay: "1", rel: "0", playsinline: "1", enablejsapi: "1" });
		const start = parseStartSeconds(href);
		if (start > 0) params.set("start", String(start));
		frame.empty();
		const iframe = frame.createEl("iframe", {
			attr: {
				src: `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`,
				allow: "autoplay; encrypted-media; picture-in-picture; fullscreen",
				allowfullscreen: "",
				referrerpolicy: "strict-origin-when-cross-origin",
			},
		});
		iframe.addEventListener("load", () => {
			const post = (message: object): void => iframe.contentWindow?.postMessage(JSON.stringify(message), "*");
			post({ event: "listening", id: 1, channel: "widget" });
			post({ event: "command", func: "addEventListener", args: ["onStateChange"] });
		});
	}

	async setAutoplay(value: boolean): Promise<void> {
		this.settings.autoplayNext = value;
		this.syncAutoplayUi();
		await this.saveSettings();
	}

	syncAutoplayUi(): void {
		if (this.player) this.styleAutoplayButton(this.player.autoplayButton);
	}

	private styleAutoplayButton(button: HTMLElement): void {
		const on = this.settings.autoplayNext;
		button.toggleClass("is-active", on);
		button.setAttr("aria-label", on ? "Autoplay: on" : "Autoplay: off");
		button.setAttr("aria-pressed", String(on));
	}

	private async stepQueue(direction: 1 | -1): Promise<void> {
		const current = this.player;
		const queue = current?.queue;
		if (!current || !queue || !current.entry) return;
		const skip = (i: number): boolean => i >= 0 && i < queue.items.length && queue.items[i].el.hasClass("ytg-unavailable");
		let index = queue.items.indexOf(current.entry) + direction;
		for (;;) {
			while (skip(index)) index += direction;
			if (index >= 0 && index < queue.items.length) break;
			if (direction < 0 || !queue.loadMore || !(await queue.loadMore())) return;
			if (this.player !== current) return;
		}
		const target = queue.items[index];
		this.playVideo(target.id, target.href, queue, target);
	}

	private playVideo(id: string, href: string, queue?: VideoQueue, entry?: QueueEntry): void {
		if (this.player) {
			Object.assign(this.player, { href, queue, entry, ended: false });
			this.playerIframe(this.player.frame, id, href);
			return;
		}

		const el = document.body.createDiv({ cls: "ytg-player" });
		const bar = el.createDiv({ cls: "ytg-player-bar" });
		const grip = bar.createDiv({ cls: "ytg-player-grip" });
		setIcon(grip, "grip-horizontal");
		const previousButton = bar.createEl("button", { cls: "ytg-player-btn", attr: { "aria-label": "Previous video" } });
		setIcon(previousButton, "skip-back");
		const nextButton = bar.createEl("button", { cls: "ytg-player-btn", attr: { "aria-label": "Next video" } });
		setIcon(nextButton, "skip-forward");
		const autoplayButton = bar.createEl("button", { cls: "ytg-player-btn ytg-player-autoplay" });
		setIcon(autoplayButton, "repeat");
		this.styleAutoplayButton(autoplayButton);
		const copyButton = bar.createEl("button", { cls: "ytg-player-btn ytg-player-copy", attr: { "aria-label": "Copy link" } });
		setIcon(copyButton, "copy");
		const openButton = bar.createEl("button", { cls: "ytg-player-btn ytg-player-open", attr: { "aria-label": "Open in browser" } });
		setIcon(openButton, "arrow-up-right");
		const closeButton = bar.createEl("button", { cls: "ytg-player-btn ytg-player-close", attr: { "aria-label": "Close" } });
		setIcon(closeButton, "x");
		const frame = el.createDiv({ cls: "ytg-player-frame" });

		const place = (left: number, top: number): void => {
			const rect = el.getBoundingClientRect();
			const x = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - rect.width));
			const y = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - rect.height));
			el.setCssProps({ left: `${x}px`, top: `${y}px`, right: "auto", bottom: "auto", transform: "none" });
		};

		let grab: { dx: number; dy: number } | null = null;
		grip.addEventListener("pointerdown", (evt) => {
			const rect = el.getBoundingClientRect();
			grab = { dx: evt.clientX - rect.left, dy: evt.clientY - rect.top };
			grip.setPointerCapture(evt.pointerId);
			el.addClass("is-dragging");
			evt.preventDefault();
		});
		grip.addEventListener("pointermove", (evt) => {
			if (grab) place(evt.clientX - grab.dx, evt.clientY - grab.dy);
		});
		const drop = (evt: PointerEvent): void => {
			if (!grab) return;
			grab = null;
			grip.releasePointerCapture(evt.pointerId);
			el.removeClass("is-dragging");
		};
		grip.addEventListener("pointerup", drop);
		grip.addEventListener("pointercancel", drop);

		const MIN_WIDTH = 320;
		const barHeight = (): number => bar.getBoundingClientRect().height;
		const maxWidth = (): number => Math.min(window.innerWidth, ((window.innerHeight - barHeight()) * 16) / 9);
		type Edge = "e" | "w" | "s" | "se" | "sw";
		for (const edge of ["e", "w", "s", "se", "sw"] as Edge[]) {
			const handle = el.createDiv({ cls: `ytg-player-resize ytg-resize-${edge}` });
			let start: { x: number; y: number; left: number; width: number } | null = null;
			handle.addEventListener("pointerdown", (evt) => {
				const rect = el.getBoundingClientRect();
				place(rect.left, rect.top);
				start = { x: evt.clientX, y: evt.clientY, left: rect.left, width: rect.width };
				handle.setPointerCapture(evt.pointerId);
				el.addClass("is-dragging");
				evt.preventDefault();
				evt.stopPropagation();
			});
			handle.addEventListener("pointermove", (evt) => {
				if (!start) return;
				const dx = evt.clientX - start.x;
				const dy = evt.clientY - start.y;
				const fromLeft = edge === "w" || edge === "sw";
				let width = edge === "s" ? start.width + (dy * 16) / 9 : fromLeft ? start.width - dx : start.width + dx;
				const room = fromLeft ? start.left + start.width : window.innerWidth - start.left;
				width = Math.max(MIN_WIDTH, Math.min(width, maxWidth(), room));
				el.style.setProperty("width", `${width}px`);
				if (fromLeft) el.style.setProperty("left", `${start.left + start.width - width}px`);
				place(parseFloat(el.style.left), parseFloat(el.style.top));
			});
			const release = (evt: PointerEvent): void => {
				if (!start) return;
				start = null;
				handle.releasePointerCapture(evt.pointerId);
				el.removeClass("is-dragging");
			};
			handle.addEventListener("pointerup", release);
			handle.addEventListener("pointercancel", release);
		}

		const onResize = (): void => {
			if (el.style.width && el.offsetWidth > maxWidth()) el.style.setProperty("width", `${Math.max(MIN_WIDTH, maxWidth())}px`);
			if (el.style.left) place(parseFloat(el.style.left), parseFloat(el.style.top));
		};
		window.addEventListener("resize", onResize);

		previousButton.addEventListener("click", () => void this.stepQueue(-1));
		nextButton.addEventListener("click", () => void this.stepQueue(1));
		autoplayButton.addEventListener("click", () => void this.setAutoplay(!this.settings.autoplayNext));

		const onMessage = (evt: MessageEvent): void => {
			const player = this.player;
			const iframe = player?.frame.querySelector("iframe");
			if (!player || !iframe || evt.source !== iframe.contentWindow) return;
			let data: { event?: string; info?: unknown } | null = null;
			try {
				data = typeof evt.data === "string" ? JSON.parse(evt.data) : evt.data;
			} catch {
				return;
			}
			const info = data?.info as { playerState?: number } | number | undefined;
			const state = data?.event === "onStateChange" ? info : data?.event === "infoDelivery" ? (info as { playerState?: number })?.playerState : undefined;
			if (state === 0) {
				if (player.ended) return;
				player.ended = true;
				if (this.settings.autoplayNext) void this.stepQueue(1);
			} else if (state === 1) {
				player.ended = false;
			}
		};
		window.addEventListener("message", onMessage);

		let copyTimer = 0;
		copyButton.addEventListener("click", () => {
			void this.copyText(this.player?.href ?? href, "Link copied.");
			setIcon(copyButton, "check");
			window.clearTimeout(copyTimer);
			copyTimer = window.setTimeout(() => setIcon(copyButton, "copy"), 1200);
		});
		openButton.addEventListener("click", () => {
			window.open(this.player?.href ?? href, "_blank");
			this.closePlayer();
		});
		closeButton.addEventListener("click", () => this.closePlayer());

		this.player = { el, frame, href, onResize, onMessage, autoplayButton, queue, entry, ended: false };
		this.playerIframe(frame, id, href);

		const rect = el.getBoundingClientRect();
		place((window.innerWidth - rect.width) / 2, (window.innerHeight - rect.height) / 2);
	}

	private closePlayer(): void {
		if (!this.player) return;
		window.removeEventListener("resize", this.player.onResize);
		window.removeEventListener("message", this.player.onMessage);
		this.player.el.remove();
		this.player = null;
	}

	private openLink(link: HTMLAnchorElement, href: string, play?: () => void, enabled: () => boolean = () => this.settings.playInObsidian): void {
		link.addEventListener("click", (evt) => {
			evt.preventDefault();
			const inBrowser = evt.ctrlKey || evt.metaKey;
			if (play && enabled() && !inBrowser) {
				play();
			} else {
				window.open(href, "_blank");
			}
		});
	}

	private observers = new Set<IntersectionObserver>();
	private observerMap = new WeakMap<object, Map<number, IntersectionObserver>>();
	private pendingLoads = new WeakMap<Element, () => void>();

	/**
	 * Runs `start` when `el` comes within the preload distance of the visible area (or is visible, with preloading
	 * off). Replaces the browser's own lazy loading, whose distance we cannot control.
	 */
	whenNear(el: HTMLElement, start: () => void): void {
		if (typeof IntersectionObserver === "undefined") {
			start();
			return;
		}
		let frames = 0;
		const attach = (): void => {
			// The gallery is built before Obsidian puts it on screen, so wait until it is attached.
			if (!el.isConnected) {
				if (++frames < 600) window.requestAnimationFrame(attach);
				return;
			}
			const margin = this.settings.preloadImages ? PRELOAD_MARGIN : 0;
			const root = scrollParent(el);
			const key: object = root ?? document;
			let byMargin = this.observerMap.get(key);
			if (!byMargin) {
				byMargin = new Map();
				this.observerMap.set(key, byMargin);
			}
			let observer = byMargin.get(margin);
			if (!observer) {
				const created: IntersectionObserver = new IntersectionObserver(
					(entries) => {
						for (const entry of entries) {
							if (!entry.isIntersecting) continue;
							created.unobserve(entry.target);
							const run = this.pendingLoads.get(entry.target);
							this.pendingLoads.delete(entry.target);
							run?.();
						}
					},
					{ root, rootMargin: `${margin}px 0px` },
				);
				observer = created;
				byMargin.set(margin, created);
				this.observers.add(created);
			}
			this.pendingLoads.set(el, start);
			observer.observe(el);
		};
		attach();
	}

	createAvatar(parent: HTMLElement, large: boolean): { wrap: HTMLElement; img: HTMLImageElement } {
		const wrap = parent.createSpan({ cls: large ? "ytg-avatar ytg-avatar-lg" : "ytg-avatar" });
		const img = wrap.createEl("img", { attr: { alt: "", decoding: "async" } });
		img.hide();
		img.addEventListener("load", () => img.addClass("is-loaded"));
		img.addEventListener("error", () => img.hide());
		return { wrap, img };
	}

	private setAvatar(img: HTMLImageElement, src: string): void {
		if (!src) return;
		img.src = src;
		img.show();
	}

	renderVideo(parent: HTMLElement, item: LinkItem, id: string, preset?: { channel?: string }, queue?: VideoQueue): void {
		const { titleSource, showChannel, showChannelPicture, showViews, showDuration, showPublished } = this.settings;

		const link = parent.createEl("a", {
			cls: "ytg-item",
			attr: { href: item.href, target: "_blank", rel: "noopener noreferrer" },
		});
		const entry: QueueEntry | undefined = queue ? { id, href: item.href, el: link } : undefined;
		if (queue && entry) queue.items.push(entry);
		const play = (): void => this.playVideo(id, item.href, queue, entry);
		this.openLink(link, item.href, play);

		const thumb = link.createDiv({ cls: "ytg-thumb" });
		const img = thumb.createEl("img", { attr: { alt: "", decoding: "async" } });
		const sources = [
			`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
			`https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
		];
		let attempt = 0;
		const next = (): void => {
			attempt++;
			if (attempt < sources.length) img.src = sources[attempt];
			else img.hide();
		};
		img.addEventListener("error", next);
		img.addEventListener("load", () => {
			// YouTube answers a missing maxres picture with a tiny grey one: skip it, and only show finished images.
			if (img.naturalWidth <= 120) next();
			else img.addClass("is-loaded");
		});
		this.whenNear(thumb, () => {
			img.src = sources[0];
		});

		const durationEl = showDuration ? thumb.createDiv({ cls: "ytg-badge ytg-duration" }) : null;
		const textWrap = link.createDiv({ cls: "ytg-video-text" });
		const titleEl = textWrap.createDiv({ cls: "ytg-title", text: item.label || FALLBACK_TITLE });
		this.attachMenu(link, item.href, id, () => titleEl.textContent ?? "", play);

		const wantViews = showViews && this.hasApiKey();
		const wantPublished = showPublished && this.hasApiKey();
		const channelRow = showChannel || wantViews || wantPublished ? textWrap.createDiv({ cls: "ytg-channel" }) : null;
		const avatar = channelRow && showChannel && showChannelPicture && !preset ? this.createAvatar(channelRow, false) : null;
		const nameEl = channelRow && showChannel ? channelRow.createSpan({ cls: "ytg-channel-name" }) : null;
		const viewsEl = channelRow && wantViews ? channelRow.createSpan({ cls: "ytg-channel-views" }) : null;
		const publishedEl = channelRow && wantPublished ? channelRow.createSpan({ cls: "ytg-channel-views" }) : null;

		if (preset && !(wantViews || wantPublished || showDuration)) {
			nameEl?.setText(preset.channel ?? "");
			return;
		}

		void this.getVideoInfo(id).then((info) => {
			if (!info) return;
			if (info.unavailable) {
				link.addClass("ytg-unavailable");
				thumb.createDiv({ cls: "ytg-badge ytg-unavailable-badge", text: "Unavailable" });
				return;
			}
			if ((titleSource === "youtube" || !item.label) && info.title) titleEl.setText(info.title);
			nameEl?.setText(info.channel);
			if (viewsEl && info.views !== undefined) {
				viewsEl.empty();
				renderStat(viewsEl, "views", formatCount(info.views));
			}
			if (publishedEl && info.published) publishedEl.setText(formatAge(info.published));
			if (durationEl && info.duration) durationEl.setText(info.duration);

			const ref = avatar && info.channelUrl ? parseChannel(info.channelUrl) : null;
			if (avatar && ref) {
				void this.getChannelInfo(ref).then((channel) => {
					if (channel) this.setAvatar(avatar.img, channel.avatar);
				});
			}
		});
	}

	private renderPlaylist(parent: HTMLElement, item: LinkItem, id: string): void {
		const block = parent.createDiv({ cls: "ytg-playlist" });
		const header = block.createDiv({ cls: "ytg-playlist-header" });
		const titleRow = header.createDiv({ cls: "ytg-playlist-titlerow" });
		setIcon(titleRow.createSpan({ cls: "ytg-playlist-icon" }), "list-video");
		const titleEl = titleRow.createEl("a", {
			cls: "ytg-playlist-title",
			text: item.label || FALLBACK_PLAYLIST,
			attr: { href: item.href, target: "_blank", rel: "noopener noreferrer" },
		});
		this.openLink(titleEl, item.href);
		this.attachMenu(titleEl, item.href, undefined, () => titleEl.textContent ?? "");
		const meta = header.createDiv({ cls: "ytg-playlist-meta" });
		const descEl = header.createDiv({ cls: "ytg-playlist-desc" });
		const body = block.createDiv();

		void this.getPlaylistInfo(id).then((info) => {
			if (!info) return;
			if ((this.settings.titleSource === "youtube" || !item.label) && info.title) titleEl.setText(info.title);

			if (info.channel) {
				const author = meta.createSpan({ cls: "ytg-playlist-meta-item ytg-playlist-author" });
				const ref = info.channelUrl ? parseChannel(info.channelUrl) : null;
				const avatar = ref ? this.createAvatar(author, false) : null;
				author.createSpan({ text: info.channel });
				if (avatar && ref) {
					void this.getChannelInfo(ref).then((channel) => {
						if (channel?.avatar) this.setAvatar(avatar.img, channel.avatar);
						else avatar.wrap.remove();
					});
				}
			}
			if (info.videoCount !== undefined) {
				renderStat(meta.createSpan({ cls: "ytg-playlist-meta-item" }), "videos", formatCount(info.videoCount));
			}
			if (info.views) renderStat(meta.createSpan({ cls: "ytg-playlist-meta-item" }), "views", info.views);
			if (this.settings.showTotalDuration && this.hasApiKey()) {
				const slot = meta.createSpan({ cls: "ytg-playlist-meta-item" });
				slot.hide();
				void this.getPlaylistDuration(info, id).then((seconds) => {
					if (seconds === null) return slot.remove();
					renderStat(slot, "duration", formatTotalDuration(seconds));
					slot.show();
				});
			}
			descEl.setText(info.description);

			const gallery = this.buildGallery("video", []);
			const queue: VideoQueue = { items: [] };
			body.appendChild(gallery);
			let shown = 0;
			const addVideos = (videos: PlaylistVideo[]): void => {
				for (const video of videos) {
					const link: LinkItem = { href: `https://youtu.be/${video.id}`, label: video.title, videoId: video.id };
					this.renderVideo(gallery, link, video.id, { channel: video.channel }, queue);
				}
				shown += videos.length;
			};
			addVideos(info.videos.slice(0, PLAYLIST_PAGE));

			let more: HTMLButtonElement | null = null;
			const syncButton = (): void => {
				if (shown >= info.videos.length && !info.next) {
					more?.remove();
					more = null;
				} else if (!more) {
					const button = body.createEl("button", { cls: "ytg-playlist-more", text: "Load more" });
					button.addEventListener("click", () => void loadMore());
					more = button;
				}
			};
			const loadMore = async (): Promise<void> => {
				if (!more) return;
				more.disabled = true;
				await this.ensurePlaylistVideos(info, id, shown + PLAYLIST_PAGE);
				addVideos(info.videos.slice(shown, shown + PLAYLIST_PAGE));
				if (more) more.disabled = false;
				syncButton();
			};
			syncButton();

			queue.loadMore = async (): Promise<boolean> => {
				const before = shown;
				if (shown >= info.videos.length) await this.ensurePlaylistVideos(info, id, shown + PLAYLIST_PAGE);
				addVideos(info.videos.slice(shown, shown + PLAYLIST_PAGE));
				syncButton();
				return shown > before;
			};
		});
	}

	private renderChannel(parent: HTMLElement, item: LinkItem, ref: ChannelRef): void {
		const link = parent.createEl("a", {
			cls: "ytg-item ytg-channel-card",
			attr: { href: item.href, target: "_blank", rel: "noopener noreferrer" },
		});
		const openPage = (): void => void this.openChannelView(ref);
		this.openLink(link, item.href, openPage, () => this.settings.channelPage);

		const avatar = this.createAvatar(link, true);
		const text = link.createDiv({ cls: "ytg-channel-text" });
		const nameEl = text.createDiv({
			cls: "ytg-channel-title",
			text: item.label || (ref.handle ? `@${ref.handle}` : ref.key),
		});
		const statsEl = text.createDiv({ cls: "ytg-channel-stats" });
		this.attachMenu(link, item.href, undefined, () => nameEl.textContent ?? "", undefined, openPage);

		void this.getChannelInfo(ref).then((channel) => {
			if (!channel) return;
			if ((this.settings.titleSource === "youtube" || !item.label) && channel.name) {
				nameEl.setText(channel.name);
			}
			this.setAvatar(avatar.img, channel.avatar);
			const { showSubscribers, showVideoCount } = this.settings;
			const stats: { kind: StatKind; value: string }[] = [];
			if (showSubscribers && channel.subscribers) stats.push({ kind: "subscribers", value: channel.subscribers });
			if (showVideoCount && channel.videos) stats.push({ kind: "videos", value: channel.videos });

			statsEl.empty();
			statsEl.toggleClass("ytg-stats-icons", stats.length > 0);
			for (const stat of stats) renderStat(statsEl, stat.kind, stat.value);
		});
	}

	private hasApiKey(): boolean {
		return this.settings.apiKey.trim().length > 0 && !this.apiBroken;
	}

	private async getVideoInfo(id: string): Promise<VideoInfo | null> {
		if (this.unavailable.has(id)) return UNAVAILABLE_INFO;
		const wantFull = this.hasApiKey();
		const cached = this.settings.cache[id];
		const fresh = cached && cached.v === CACHE_VERSION && !isExpired(cached.at);
		if (fresh && (cached.full || !wantFull)) return cached;

		const key = `${id}:${wantFull}`;
		if (this.failed.has(key)) return fresh ? cached : null;

		let request = this.pendingVideos.get(key);
		if (!request) {
			request = this.fetchVideoInfo(id, wantFull)
				.then((info) => {
					if (info === "unavailable") {
						this.unavailable.add(id);
						return UNAVAILABLE_INFO;
					}
					if (info) {
						info.at = Date.now();
						this.settings.cache[id] = info;
						this.persistSoon();
					} else {
						this.failed.add(key);
					}
					return info;
				})
				.finally(() => this.pendingVideos.delete(key));
			this.pendingVideos.set(key, request);
		}
		return (await request) ?? (fresh ? cached : null);
	}

	private async fetchVideoInfo(id: string, useApi: boolean): Promise<VideoInfo | "unavailable" | null> {
		if (useApi) {
			const info = await this.fetchVideoFromApi(id);
			if (info) return info;
		}
		return this.fetchVideoFromOembed(id);
	}

	private async fetchVideoFromApi(id: string): Promise<VideoInfo | "unavailable" | null> {
		try {
			const url =
				"https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics" +
				`&id=${encodeURIComponent(id)}&key=${encodeURIComponent(this.settings.apiKey.trim())}`;
			const res = await requestUrl({ url, throw: false });

			if (res.status === 400 || res.status === 403) this.apiBroken = true;
			if (res.status !== 200) return null;

			const item = res.json?.items?.[0];
			if (!item && Array.isArray(res.json?.items)) return "unavailable";
			if (!item?.snippet?.title) return null;

			const views = Number(item.statistics?.viewCount);
			const channelId = item.snippet.channelId ? String(item.snippet.channelId) : "";
			return {
				title: String(item.snippet.title),
				channel: String(item.snippet.channelTitle ?? ""),
				channelUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : undefined,
				views: Number.isFinite(views) ? views : undefined,
				duration: formatDuration(String(item.contentDetails?.duration ?? "")) || undefined,
				durationSeconds: parseDurationSeconds(String(item.contentDetails?.duration ?? "")) ?? undefined,
				published: item.snippet.publishedAt ? String(item.snippet.publishedAt) : undefined,
				full: true,
				v: CACHE_VERSION,
			};
		} catch {
			return null;
		}
	}

	private async fetchVideoFromOembed(id: string): Promise<VideoInfo | "unavailable" | null> {
		try {
			const video = encodeURIComponent(`https://www.youtube.com/watch?v=${id}`);
			const res = await requestUrl({
				url: `https://www.youtube.com/oembed?format=json&url=${video}`,
				throw: false,
			});
			if (res.status === 404) return "unavailable";
			if (res.status !== 200 || !res.json?.title) return null;
			return {
				title: String(res.json.title),
				channel: String(res.json.author_name ?? ""),
				channelUrl: res.json.author_url ? String(res.json.author_url) : undefined,
				full: false,
				v: CACHE_VERSION,
			};
		} catch {
			return null;
		}
	}

	async openChannelView(ref: ChannelRef): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_CHANNEL).find((leaf) => leaf.view instanceof ChannelView && leaf.view.refKey === ref.key);
		const leaf = existing ?? workspace.getLeaf("tab");
		if (!existing) await leaf.setViewState({ type: VIEW_CHANNEL, active: true, state: { ref, sort: "recent" } });
		await workspace.revealLeaf(leaf);
	}

	async openChannelFeed(ref: ChannelRef, sort: ChannelSort): Promise<ChannelFeed> {
		if (this.hasApiKey()) {
			const id = await this.resolveChannelId(ref);
			if (id) return this.apiFeed(id, sort);
		}
		return this.pageFeed(ref, sort);
	}

	private channelIds = new Map<string, string>();

	private async resolveChannelId(ref: ChannelRef): Promise<string | null> {
		if (ref.id) return ref.id;
		const known = this.channelIds.get(ref.key);
		if (known) return known;
		if (!ref.handle && !ref.user) return null;
		try {
			const lookup = ref.handle ? `forHandle=${encodeURIComponent("@" + ref.handle)}` : `forUsername=${encodeURIComponent(ref.user ?? "")}`;
			const res = await requestUrl({
				url: `https://www.googleapis.com/youtube/v3/channels?part=id&${lookup}&key=${encodeURIComponent(this.settings.apiKey.trim())}`,
				throw: false,
			});
			if (res.status === 400 || res.status === 403) this.apiBroken = true;
			const id = res.status === 200 ? res.json?.items?.[0]?.id : null;
			if (id) this.channelIds.set(ref.key, String(id));
			return id ? String(id) : null;
		} catch {
			return null;
		}
	}

	private apiFeed(channelId: string, sort: ChannelSort): ChannelFeed {
		const base = "https://www.googleapis.com/youtube/v3";
		const key = encodeURIComponent(this.settings.apiKey.trim());
		const channel = encodeURIComponent(channelId);
		const uploads = encodeURIComponent("UU" + channelId.slice(2));
		let token: string | undefined;
		let oldest: PlaylistVideo[] | null = null;

		const page = async (): Promise<PlaylistVideo[] | null> => {
			try {
				const url =
					(sort === "popular"
						? `${base}/search?part=snippet&type=video&order=viewCount&maxResults=50&channelId=${channel}`
						: `${base}/playlistItems?part=snippet&maxResults=50&playlistId=${uploads}`) +
					`&key=${key}` +
					(token ? `&pageToken=${encodeURIComponent(token)}` : "");
				const res = await requestUrl({ url, throw: false });
				if (res.status === 400 || res.status === 403) this.apiBroken = true;
				if (res.status !== 200) return null;
				token = res.json?.nextPageToken ? String(res.json.nextPageToken) : undefined;
				if (sort !== "popular") return parsePlaylistApiItems(res.json?.items);
				const found: PlaylistVideo[] = [];
				for (const item of Array.isArray(res.json?.items) ? res.json.items : []) {
					const id = String(item?.id?.videoId ?? "");
					if (!VIDEO_ID.test(id)) continue;
					found.push({ id, title: String(item?.snippet?.title ?? ""), channel: item?.snippet?.channelTitle ? String(item.snippet.channelTitle) : undefined });
				}
				return found;
			} catch {
				return null;
			}
		};

		const feed: ChannelFeed = {
			done: false,
			async next() {
				if (sort === "oldest") {
					if (!oldest) {
						const all: PlaylistVideo[] = [];
						for (let n = 0; n < 100; n++) {
							const batch = await page();
							if (!batch) break;
							all.push(...batch);
							if (!token) break;
						}
						oldest = all.reverse();
					}
					const batch = oldest.splice(0, PLAYLIST_PAGE);
					feed.done = oldest.length === 0;
					return batch;
				}
				const batch = await page();
				feed.done = !batch || !token;
				return batch ?? [];
			},
		};
		return feed;
	}

	private pageFeed(ref: ChannelRef, sort: ChannelSort): ChannelFeed {
		let ctx: { key: string; version: string } | null = null;
		let token: string | undefined;
		let started = false;

		const browse = async (continuation: string): Promise<unknown> => {
			if (!ctx) return null;
			try {
				const res = await requestUrl({
					url: `https://www.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(ctx.key)}&prettyPrint=false`,
					method: "POST",
					contentType: "application/json",
					headers: { "Accept-Language": "en-US,en;q=0.9" },
					body: JSON.stringify({
						context: { client: { clientName: "WEB", clientVersion: ctx.version, hl: "en", gl: "US" } },
						continuation,
					}),
					throw: false,
				});
				return res.status === 200 ? res.json : null;
			} catch {
				return null;
			}
		};
		const gridToken = (root: unknown): string | undefined => {
			const node = findAll(root, "continuationItemRenderer")[0];
			return node ? continuationToken(node) : undefined;
		};

		const feed: ChannelFeed = {
			done: false,
			async next() {
				let source: unknown = null;
				if (!started) {
					started = true;
					try {
						const res = await requestUrl({
							url: `${ref.url}/videos`,
							headers: { "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1; SOCS=CAI" },
							throw: false,
						});
						if (res.status === 200) {
							const key = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(res.text)?.[1];
							const version = /"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/.exec(res.text)?.[1];
							if (key && version) ctx = { key, version };
							source = extractInitialData(res.text);
							if (source && sort !== "recent") {
								const chips = findAll(source, "chipCloudChipRenderer") as { text?: unknown }[];
								const chip = chips.find((entry) => textOf(entry.text).trim().toLowerCase() === sort);
								const chipToken = chip ? continuationToken(chip) : undefined;
								source = chipToken ? await browse(chipToken) : null;
							}
						}
					} catch {
						source = null;
					}
				} else if (token) {
					source = await browse(token);
				}
				token = gridToken(source);
				feed.done = !token;
				return extractChannelVideos(source);
			},
		};
		return feed;
	}

	async getChannelInfo(ref: ChannelRef): Promise<ChannelInfo | null> {
		const cached = this.settings.channelCache[ref.key];
		if (cached && cached.v === CACHE_VERSION && !isExpired(cached.at)) return cached;
		if (this.failed.has(`channel:${ref.key}`)) return null;

		let request = this.pendingChannels.get(ref.key);
		if (!request) {
			request = this.fetchChannelInfo(ref)
				.then((info) => {
					if (info) {
						info.at = Date.now();
						this.settings.channelCache[ref.key] = info;
						this.persistSoon();
					} else {
						this.failed.add(`channel:${ref.key}`);
					}
					return info;
				})
				.finally(() => this.pendingChannels.delete(ref.key));
			this.pendingChannels.set(ref.key, request);
		}
		return request;
	}

	private addGalleryTotal(gallery: HTMLElement, ids: string[]): void {
		const line = gallery.createDiv({ cls: "ytg-total" });
		void Promise.all(ids.map((id) => this.getVideoInfo(id))).then((infos) => {
			let seconds = 0;
			let count = 0;
			for (const info of infos) {
				if (info?.unavailable) continue;
				if (info?.durationSeconds === undefined) return line.remove();
				seconds += info.durationSeconds;
				count++;
			}
			if (count === 0) return line.remove();
			line.setText(`${plural(count, "video")} · ${formatTotalDuration(seconds)}`);
		});
	}

	private pendingDurations = new Map<string, Promise<number | null>>();

	private async getPlaylistDuration(info: PlaylistInfo, id: string): Promise<number | null> {
		if (info.totalSeconds !== undefined) return info.totalSeconds;
		let request = this.pendingDurations.get(id);
		if (!request) {
			request = this.sumPlaylistDuration(id)
				.then((total) => {
					if (total !== null) {
						info.totalSeconds = total;
						this.persistSoon();
					}
					return total;
				})
				.finally(() => this.pendingDurations.delete(id));
			this.pendingDurations.set(id, request);
		}
		return request;
	}

	private async sumPlaylistDuration(id: string): Promise<number | null> {
		const base = "https://www.googleapis.com/youtube/v3";
		const key = encodeURIComponent(this.settings.apiKey.trim());
		const get = async (url: string): Promise<{ items?: unknown; nextPageToken?: unknown } | null> => {
			try {
				const res = await requestUrl({ url, throw: false });
				if (res.status === 400 || res.status === 403) this.apiBroken = true;
				return res.status === 200 ? res.json : null;
			} catch {
				return null;
			}
		};

		const ids: string[] = [];
		let token: string | undefined;
		for (let page = 0; page < 100; page++) {
			const list = await get(
				`${base}/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(id)}&key=${key}` +
					(token ? `&pageToken=${encodeURIComponent(token)}` : ""),
			);
			if (!list) return null;
			for (const entry of Array.isArray(list.items) ? list.items : []) {
				const videoId = String(entry?.contentDetails?.videoId ?? "");
				if (VIDEO_ID.test(videoId)) ids.push(videoId);
			}
			token = list.nextPageToken ? String(list.nextPageToken) : undefined;
			if (!token) break;
		}

		let total = 0;
		for (let i = 0; i < ids.length; i += 50) {
			const details = await get(`${base}/videos?part=contentDetails&maxResults=50&id=${ids.slice(i, i + 50).join(",")}&key=${key}`);
			if (!details) return null;
			for (const entry of Array.isArray(details.items) ? details.items : []) {
				total += parseDurationSeconds(String(entry?.contentDetails?.duration ?? "")) ?? 0;
			}
		}
		return total;
	}

	private async getPlaylistInfo(id: string): Promise<PlaylistInfo | null> {
		const cached = this.settings.playlistCache[id];
		const usable = cached && cached.v === CACHE_VERSION && !isExpired(cached.fetched);
		if (usable && Date.now() - cached.fetched < PLAYLIST_TTL) return cached;
		if (this.failed.has(`playlist:${id}`)) return usable ? cached : null;

		let request = this.pendingPlaylists.get(id);
		if (!request) {
			request = this.fetchPlaylistInfo(id)
				.then((info) => {
					if (info) {
						this.settings.playlistCache[id] = info;
						this.persistSoon();
					} else {
						this.failed.add(`playlist:${id}`);
					}
					return info;
				})
				.finally(() => this.pendingPlaylists.delete(id));
			this.pendingPlaylists.set(id, request);
		}
		return (await request) ?? (usable ? cached : null);
	}

	private async fetchPlaylistInfo(id: string): Promise<PlaylistInfo | null> {
		const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`;
		const [oembed, page, api] = await Promise.all([
			this.fetchPlaylistFromOembed(url),
			this.fetchPlaylistFromPage(url),
			this.hasApiKey() ? this.fetchPlaylistFromApi(id) : Promise.resolve(null),
		]);

		const title = api?.title || oembed?.title || page?.title || "";
		const fromApi = (api?.videos?.length ?? 0) > 0;
		const videos = (fromApi ? api?.videos : page?.videos) ?? [];
		if (!title && videos.length === 0) return null;
		return {
			title,
			description: api?.description || page?.description || "",
			channel: api?.channel || oembed?.channel || page?.channel || "",
			channelUrl: api?.channelUrl || oembed?.channelUrl,
			videoCount: api?.videoCount ?? page?.videoCount,
			views: page?.views,
			videos,
			next: fromApi ? api?.next : page?.next,
			fetched: Date.now(),
			v: CACHE_VERSION,
		};
	}

	private async ensurePlaylistVideos(info: PlaylistInfo, id: string, count: number): Promise<void> {
		while (info.videos.length < count && info.next) await this.fetchNextPlaylistPage(info, id);
	}

	private async fetchNextPlaylistPage(info: PlaylistInfo, id: string): Promise<void> {
		const next = info.next;
		info.next = undefined;
		if (!next) return;
		try {
			let found: PlaylistVideo[];
			if (next.source === "api") {
				if (!this.hasApiKey()) return;
				const url =
					"https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50" +
					`&playlistId=${encodeURIComponent(id)}&pageToken=${encodeURIComponent(next.token)}` +
					`&key=${encodeURIComponent(this.settings.apiKey.trim())}`;
				const res = await requestUrl({ url, throw: false });
				if (res.status === 400 || res.status === 403) this.apiBroken = true;
				if (res.status !== 200) return;
				found = parsePlaylistApiItems(res.json?.items);
				if (res.json?.nextPageToken) info.next = { source: "api", token: String(res.json.nextPageToken) };
			} else {
				const res = await requestUrl({
					url: `https://www.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(next.key)}&prettyPrint=false`,
					method: "POST",
					contentType: "application/json",
					headers: { "Accept-Language": "en-US,en;q=0.9" },
					body: JSON.stringify({
						context: { client: { clientName: "WEB", clientVersion: next.version, hl: "en", gl: "US" } },
						continuation: next.token,
					}),
					throw: false,
				});
				if (res.status !== 200) return;
				found = extractPlaylistVideos(res.json);
				const token = continuationToken(res.json);
				if (token) info.next = { ...next, token };
			}
			const known = new Set(info.videos.map((video) => video.id));
			info.videos.push(...found.filter((video) => !known.has(video.id)));
			this.persistSoon();
		} catch {
		}
	}

	private async fetchPlaylistFromOembed(url: string): Promise<PlaylistPart | null> {
		try {
			const res = await requestUrl({
				url: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
				throw: false,
			});
			if (res.status !== 200 || !res.json?.title) return null;
			return {
				title: String(res.json.title),
				channel: String(res.json.author_name ?? ""),
				channelUrl: res.json.author_url ? String(res.json.author_url) : undefined,
			};
		} catch {
			return null;
		}
	}

	private async fetchPlaylistFromApi(id: string): Promise<PlaylistPart | null> {
		try {
			const key = encodeURIComponent(this.settings.apiKey.trim());
			const base = "https://www.googleapis.com/youtube/v3";
			const meta = await requestUrl({
				url: `${base}/playlists?part=snippet,contentDetails&id=${encodeURIComponent(id)}&key=${key}`,
				throw: false,
			});
			if (meta.status === 400 || meta.status === 403) this.apiBroken = true;
			const item = meta.status === 200 ? meta.json?.items?.[0] : null;
			if (!item?.snippet) return null;

			const videos: PlaylistVideo[] = [];
			let token: string | undefined;
			do {
				const list = await requestUrl({
					url:
						`${base}/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(id)}&key=${key}` +
						(token ? `&pageToken=${encodeURIComponent(token)}` : ""),
					throw: false,
				});
				if (list.status !== 200) break;
				videos.push(...parsePlaylistApiItems(list.json?.items));
				token = list.json?.nextPageToken ? String(list.json.nextPageToken) : undefined;
			} while (token && videos.length < PLAYLIST_PAGE);

			const count = Number(item.contentDetails?.itemCount);
			const channelId = item.snippet.channelId ? String(item.snippet.channelId) : "";
			return {
				title: String(item.snippet.title ?? ""),
				description: String(item.snippet.description ?? ""),
				channel: String(item.snippet.channelTitle ?? ""),
				channelUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : undefined,
				videoCount: Number.isFinite(count) ? count : undefined,
				videos,
				next: token ? { source: "api", token } : undefined,
			};
		} catch {
			return null;
		}
	}

	private async fetchPlaylistFromPage(url: string): Promise<PlaylistPart | null> {
		try {
			const res = await requestUrl({
				url,
				headers: { "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1; SOCS=CAI" },
				throw: false,
			});
			if (res.status !== 200) return null;

			const html = res.text;
			const part: PlaylistPart = { title: metaContent(html, "og:title") ?? undefined, videos: [] };
			const description = metaContent(html, "og:description") ?? "";
			if (description && !/Enjoy the videos and music you love/i.test(description)) part.description = description;

			const data = extractInitialData(html);
			if (!data) return part;

			part.videos = extractPlaylistVideos(data);
			const list = findAll(data, "playlistVideoListRenderer")[0];
			const token = list ? continuationToken(list) : undefined;
			const key = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html)?.[1];
			const version = /"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/.exec(html)?.[1];
			if (token && key && version) part.next = { source: "page", token, key, version };

			const names = ["playlistHeaderRenderer", "playlistSidebarPrimaryInfoRenderer", "pageHeaderRenderer"];
			const header = names.map((name) => findAll(data, name)[0]).find(Boolean);
			for (const text of flattenText(header).map((value) => value.trim())) {
				const count = /^(\d[\d.,\s]*)\s+videos?$/i.exec(text)?.[1];
				if (count && part.videoCount === undefined) part.videoCount = Number(count.replace(/\D/g, ""));
				const views = /^(\d[\d.,\s]*[KMB]?)\s+views?$/i.exec(text)?.[1];
				if (views && !part.views) part.views = views.trim();
			}
			return part;
		} catch {
			return null;
		}
	}

	private async fetchChannelInfo(ref: ChannelRef): Promise<ChannelInfo | null> {
		if (this.hasApiKey() && (ref.handle || ref.id || ref.user)) {
			const info = await this.fetchChannelFromApi(ref);
			if (info) return info;
		}
		return this.fetchChannelFromPage(ref);
	}

	private async fetchChannelFromApi(ref: ChannelRef): Promise<ChannelInfo | null> {
		try {
			const lookup = ref.handle
				? `forHandle=${encodeURIComponent("@" + ref.handle)}`
				: ref.id
					? `id=${encodeURIComponent(ref.id)}`
					: `forUsername=${encodeURIComponent(ref.user ?? "")}`;
			const url =
				"https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics" +
				`&${lookup}&key=${encodeURIComponent(this.settings.apiKey.trim())}`;
			const res = await requestUrl({ url, throw: false });

			if (res.status === 400 || res.status === 403) this.apiBroken = true;
			if (res.status !== 200) return null;

			const item = res.json?.items?.[0];
			if (!item?.snippet?.title) return null;

			const subs = Number(item.statistics?.subscriberCount);
			const videos = Number(item.statistics?.videoCount);
			const views = Number(item.statistics?.viewCount);
			const thumbs = item.snippet.thumbnails ?? {};
			return {
				name: String(item.snippet.title),
				avatar: String(thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url ?? ""),
				subscribers:
					!item.statistics?.hiddenSubscriberCount && Number.isFinite(subs)
						? formatCount(subs)
						: undefined,
				videos: Number.isFinite(videos) ? formatCount(videos) : undefined,
				views: Number.isFinite(views) ? views : undefined,
				v: CACHE_VERSION,
			};
		} catch {
			return null;
		}
	}

	private async fetchChannelFromPage(ref: ChannelRef): Promise<ChannelInfo | null> {
		try {
			const res = await requestUrl({
				url: ref.url,
				headers: {
					"Accept-Language": "en-US,en;q=0.9",
					Cookie: "CONSENT=YES+1; SOCS=CAI",
				},
				throw: false,
			});
			if (res.status !== 200) return null;

			const html = res.text;
			const name = metaContent(html, "og:title");
			const image = metaContent(html, "og:image");
			if (!name && !image) return null;

			const subs = /([\d.,]+\s?[KMB]?)\s+subscribers/i.exec(html)?.[1];
			const videos = /([\d.,]+\s?[KMB]?)\s+videos/i.exec(html)?.[1];
			return {
				name: name ?? "",
				avatar: image ? image.replace(/=s\d+/, "=s400") : "",
				subscribers: subs?.trim(),
				videos: videos?.trim(),
				v: CACHE_VERSION,
			};
		} catch {
			return null;
		}
	}
}

class YouTubeGallerySettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: YouTubeGalleryPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		containerEl.empty();

		const commit = async (rerender: boolean): Promise<void> => {
			await this.plugin.saveSettings();
			this.plugin.refresh(rerender);
		};

		const group = (name: string, desc?: string): HTMLElement => {
			const heading = new Setting(containerEl).setName(name).setHeading();
			if (desc) heading.setDesc(desc);
			heading.settingEl.addClass("ytg-settings-section");
			return containerEl.createDiv({ cls: "ytg-settings-card" });
		};
		const divider = (card: HTMLElement): void => {
			card.createEl("hr", { cls: "ytg-settings-divider" });
		};
		const slider = (
			card: HTMLElement,
			name: string,
			desc: string,
			key: "marginTop" | "marginBottom" | "titleSize" | "avatarSize" | "gapHorizontal" | "gapVertical" | "playerWidth",
			min: number,
			max: number,
			step: number,
		): void => {
			new Setting(card)
				.setName(name)
				.setDesc(desc)
				.addSlider((s) =>
					s
						.setLimits(min, max, step)
						.setValue(settings[key])
						.setDynamicTooltip()
						.onChange(async (value) => {
							settings[key] = value;
							await commit(false);
						}),
				);
		};

		const main = group("Advanced YouTube Features");

		new Setting(main)
			.setName("Turn video links into thumbnail galleries")
			.addToggle((toggle) =>
				toggle.setValue(settings.videoLinks).onChange(async (value) => {
					settings.videoLinks = value;
					await commit(true);
				}),
			);
		divider(main);
		new Setting(main)
			.setName("Turn channel links into profile cards")
			.addToggle((toggle) =>
				toggle.setValue(settings.channelLinks).onChange(async (value) => {
					settings.channelLinks = value;
					await commit(true);
				}),
			);
		divider(main);
		new Setting(main)
			.setName("Turn playlist links into a video thumbnail gallery")
			.addToggle((toggle) =>
				toggle.setValue(settings.playlistLinks).onChange(async (value) => {
					settings.playlistLinks = value;
					await commit(true);
				}),
			);
		divider(main);
		new Setting(main)
			.setName("Play videos in a floating window inside Obsidian")
			.addToggle((toggle) =>
				toggle.setValue(settings.playInObsidian).onChange(async (value) => {
					settings.playInObsidian = value;
					await commit(false);
				}),
			);

		divider(main);
		new Setting(main)
			.setName("Open YouTube channels as a dedicated page inside Obsidian")
			.addToggle((toggle) =>
				toggle.setValue(settings.channelPage).onChange(async (value) => {
					settings.channelPage = value;
					await commit(false);
				}),
			);

		const appearance = group("Appearance");

		new Setting(appearance)
			.setName("Card background")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("transparent", "Transparent")
					.addOption("padded", "Padded")
					.addOption("edge", "Edge to edge")
					.setValue(settings.cardBackground)
					.onChange(async (value) => {
						settings.cardBackground = value as CardBackground;
						await commit(false);
					}),
			);
		divider(appearance);
		new Setting(appearance)
			.setName("Video layout")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("vertical", "Vertical")
					.addOption("horizontal", "Horizontal")
					.setValue(settings.videoLayout)
					.onChange(async (value) => {
						settings.videoLayout = value as VideoLayout;
						await commit(false);
					}),
			);
		divider(appearance);
		new Setting(appearance)
			.setName("Channel card layout")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("horizontal", "Horizontal")
					.addOption("vertical", "Vertical")
					.setValue(settings.channelLayout)
					.onChange(async (value) => {
						settings.channelLayout = value as ChannelLayout;
						await commit(false);
					}),
			);
		divider(appearance);

		const perRow = (name: string, desc: string, key: "columns" | "channelColumns"): void => {
			new Setting(appearance)
				.setName(name)
				.setDesc(desc)
				.addDropdown((dropdown) => {
					dropdown.addOption("1", "1").addOption("2", "2").addOption("3", "3");
					if (!Platform.isMobile) dropdown.addOption("4", "4");
					dropdown.setValue(String(Math.min(settings[key], Platform.isMobile ? 3 : 4))).onChange(async (value) => {
						settings[key] = Number(value);
						await commit(false);
					});
				});
		};
		perRow("Video thumbnails per row", "", "columns");
		divider(appearance);
		perRow("Channels cards per row", "", "channelColumns");
		divider(appearance);
		slider(
			appearance,
			"Margin above each video gallery",
			"",
			"marginTop",
			0,
			64,
			2,
		);
		divider(appearance);
		slider(
			appearance,
			"Margin below each video gallery",
			"",
			"marginBottom",
			0,
			64,
			2,
		);
		divider(appearance);
		slider(
			appearance,
			"Horizontal gap between videos",
			"",
			"gapHorizontal",
			0,
			48,
			2,
		);
		divider(appearance);
		slider(
			appearance,
			"Vertical gap between videos",
			"",
			"gapVertical",
			0,
			64,
			2,
		);
		divider(appearance);
		slider(
			appearance,
			"Title text size",
			"",
			"titleSize",
			10,
			22,
			1,
		);
		divider(appearance);
		slider(
			appearance,
			"Floating video player size",
			"",
			"playerWidth",
			320,
			1280,
			40,
		);
		divider(appearance);
		new Setting(appearance)
			.setName("Highlight on hover")
			.addToggle((toggle) =>
				toggle.setValue(settings.hoverCard).onChange(async (value) => {
					settings.hoverCard = value;
					await commit(false);
				}),
			);
		divider(appearance);
		new Setting(appearance)
			.setName("Zoom thumbnail on hover")
			.addToggle((toggle) =>
				toggle.setValue(settings.hoverZoom).onChange(async (value) => {
					settings.hoverZoom = value;
					await commit(false);
				}),
			);

		if (!Platform.isMobile) {
			divider(appearance);
			const widthSetting = new Setting(appearance)
				.setName("Increase note width globally");
			const showWidthControls = (visible: boolean): void => {
				widthSetting.controlEl.toggleClass("ytg-width-off", !visible);
			};
			widthSetting
				.addSlider((slider) =>
					slider
						.setLimits(700, 2000, 50)
						.setValue(settings.noteWidth)
						.setDynamicTooltip()
						.onChange(async (value) => {
							settings.noteWidth = value;
							await commit(false);
						}),
				)
				.addToggle((toggle) =>
					toggle.setValue(settings.customNoteWidth).onChange(async (value) => {
						settings.customNoteWidth = value;
						showWidthControls(value);
						await commit(false);
					}),
				);
			showWidthControls(settings.customNoteWidth);
		}


		const info = group("Information");

		new Setting(info)
			.setName("Preferred video title")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("markdown", "Markdown link title")
					.addOption("youtube", "Original YouTube title")
					.setValue(settings.titleSource)
					.onChange(async (value) => {
						settings.titleSource = value as TitleSource;
						await commit(true);
					}),
			);
		divider(info);
		new Setting(info)
			.setName("Cut off long video titles after")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("1", "One line")
					.addOption("2", "Two lines")
					.addOption("0", "Show full title")
					.setValue(String(settings.titleLines))
					.onChange(async (value) => {
						settings.titleLines = Number(value);
						await commit(false);
					}),
			);
		divider(info);
		new Setting(info)
			.setName("Show channel name")
			.addToggle((toggle) =>
				toggle.setValue(settings.showChannel).onChange(async (value) => {
					settings.showChannel = value;
					await commit(true);
					this.display();
				}),
			);
		divider(info);
		const pictureSetting = new Setting(info)
			.setName("Show channel picture");
		const showPictureControls = (visible: boolean): void => {
			pictureSetting.controlEl.toggleClass("ytg-width-off", !visible);
		};
		pictureSetting
			.addSlider((s) =>
				s
					.setLimits(10, 48, 1)
					.setValue(settings.avatarSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.avatarSize = value;
						await commit(false);
					}),
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.showChannel && settings.showChannelPicture).setDisabled(!settings.showChannel).onChange(async (value) => {
					settings.showChannelPicture = value;
					showPictureControls(value);
					await commit(true);
				}),
			);
		showPictureControls(settings.showChannel && settings.showChannelPicture);
		divider(info);
		new Setting(info)
			.setName("Show channel's subscriber count")
			.addToggle((toggle) =>
				toggle.setValue(settings.showSubscribers).onChange(async (value) => {
					settings.showSubscribers = value;
					await commit(true);
				}),
			);
		divider(info);
		new Setting(info)
			.setName("Show channel's video count")
			.addToggle((toggle) =>
				toggle.setValue(settings.showVideoCount).onChange(async (value) => {
					settings.showVideoCount = value;
					await commit(true);
				}),
			);
		divider(info);
		new Setting(info)
			.setName("Preload thumbnails before they come into view to prevent pop-in")
			.addToggle((toggle) =>
				toggle.setValue(settings.preloadImages).onChange(async (value) => {
					settings.preloadImages = value;
					await commit(true);
				}),
			);

		const api = group("Information (API key required)");

		new Setting(api)
			.setName("Show view count")
			.addToggle((toggle) =>
				toggle.setValue(settings.showViews).onChange(async (value) => {
					settings.showViews = value;
					await commit(true);
				}),
			);
		divider(api);
		new Setting(api)
			.setName("Show video duration")
			.addToggle((toggle) =>
				toggle.setValue(settings.showDuration).onChange(async (value) => {
					settings.showDuration = value;
					await commit(true);
				}),
			);
		divider(api);
		new Setting(api)
			.setName("Show publish date")
			.addToggle((toggle) =>
				toggle.setValue(settings.showPublished).onChange(async (value) => {
					settings.showPublished = value;
					await commit(true);
				}),
			);
		divider(api);
		new Setting(api)
			.setName("Show video count and total duration")
			.addToggle((toggle) =>
				toggle.setValue(settings.showTotalDuration).onChange(async (value) => {
					settings.showTotalDuration = value;
					await commit(true);
				}),
			);
		divider(api);
		new Setting(api)
			.setName("Sort channel's videos by popular or oldest")
			.addToggle((toggle) =>
				toggle.setValue(settings.channelSorting).onChange(async (value) => {
					settings.channelSorting = value;
					await commit(true);
				}),
			);
		divider(api);
		const linkButton = (setting: Setting, text: string, url: string): void => {
			setting.addButton((button) => {
				button.setButtonText(text).onClick(() => {
					window.open(url, "_blank");
				});
				setIcon(button.buttonEl.createSpan({ cls: "ytg-link-icon" }), "arrow-up-right");
			});
		};

		const enableApi = new Setting(api)
			.setName("Enable YouTube Data API")
			.setDesc("Allows to fetch additional data. Logging in is required.");
		linkButton(enableApi, "YouTube Data API", "https://console.cloud.google.com/apis/library/youtube.googleapis.com");
		divider(api);
		const createKey = new Setting(api)
			.setName("Create an API key")
			.setDesc("Create credentials, choose API key, then copy the key.");
		linkButton(createKey, "API credentials", "https://console.cloud.google.com/apis/credentials");
		divider(api);
		new Setting(api)
			.setName("YouTube Data API key")
			.setDesc("The key is stored unencrypted in this plugin's data file.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("API key")
					.setValue(settings.apiKey)
					.onChange(async (value) => {
						settings.apiKey = value.trim();
						this.plugin.resetApiState();
						await commit(true);
					});
			});
		divider(api);
		new Setting(api)
			.setName("Test API key")
			.addButton((button) =>
				button.setButtonText("Test key").onClick(async () => {
					await this.plugin.testApiKey();
				}),
			);

		const tools = group("Tools");
		new Setting(tools)
			.setName("Automatically add titles to pasted YouTube links")
			.addToggle((toggle) =>
				toggle.setValue(settings.titleOnPaste).onChange(async (value) => {
					settings.titleOnPaste = value;
					await commit(false);
				}),
			);
		divider(tools);
		let titlesButton: ButtonComponent | null = null;
		let shortenButton: ButtonComponent | null = null;
		let clearButton: ButtonComponent | null = null;
		const toolIcon = (button: ButtonComponent | null, icon: string): void => {
			if (button) setIcon(button.buttonEl.createSpan({ cls: "ytg-link-icon" }), icon);
		};
		new Setting(tools)
			.setName("Add missing titles to YouTube links")
			.addButton((button) =>
				(titlesButton = button).setButtonText("Scan notes").onClick(async () => {
					button.setDisabled(true);
					try {
						await this.plugin.offerBareLinkConversion();
					} finally {
						button.setDisabled(false);
					}
				}),
			);
		toolIcon(titlesButton, "pencil");

		divider(tools);
		new Setting(tools)
			.setName("Shorten video links into youtu.be/ID")
			.addButton((button) =>
				(shortenButton = button).setButtonText("Scan notes").onClick(async () => {
					button.setDisabled(true);
					try {
						await this.plugin.offerLinkShortening();
					} finally {
						button.setDisabled(false);
					}
				}),
			);
		toolIcon(shortenButton, "scissors");
		divider(tools);
		new Setting(tools)
			.setName("Clear cached information")
			.addButton((button) =>
				(clearButton = button).setButtonText("Clear cache").onClick(async () => {
					await this.plugin.clearCache();
					new Notice("Cache cleared.");
				}),
			);
		toolIcon(clearButton, "trash-2");

		const support = group("Support");

		const email = "contact@kgniewek.com";
		new Setting(support)
			.setName("Contact")
			.setDesc("Found a bug or have a suggestion? Get in touch.")
			.addButton((button) => {
				button.setButtonText(email).onClick(async () => {
					try {
						await navigator.clipboard.writeText(email);
						new Notice(`${email} copied`);
					} catch {
						new Notice(`Could not copy. Email: ${email}`);
					}
				});
				setIcon(button.buttonEl.createSpan({ cls: "ytg-link-icon" }), "copy");
			});
		divider(support);

		const coffee = new Setting(support)
			.setName("Buy me a coffee")
			.setDesc("If you enjoy this plugin, you can support its development.");
		linkButton(coffee, "Buy me a coffee", "https://buymeacoffee.com/kgniewek");
	}
}
