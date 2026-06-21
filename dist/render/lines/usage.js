import { isLimitReached } from "../../types.js";
import { shouldHideUsage } from "../../stdin.js";
import { critical, label, getQuotaColor, quotaBar, RESET } from "../colors.js";
import { getAdaptiveBarWidth } from "../../utils/terminal.js";
import { t } from "../../i18n/index.js";
import { progressLabel } from "./label-align.js";
import { formatResetTime } from "../format-reset-time.js";
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export function renderUsageLine(ctx, alignLabels = false) {
    const display = ctx.config?.display;
    const colors = ctx.config?.colors;
    if (display?.showUsage === false) {
        return null;
    }
    if (!ctx.usageData) {
        return null;
    }
    if (shouldHideUsage(ctx.stdin)) {
        return null;
    }
    const usageLabel = progressLabel("label.usage", colors, alignLabels);
    const balanceLabel = ctx.usageData.balanceLabel ?? null;
    const hasWindowData = ctx.usageData.fiveHour !== null || ctx.usageData.sevenDay !== null;
    // When a snapshot supplies concrete dollar details (e.g. a provider balance), a
    // fully-used window should still render its bar + remaining amount rather than the
    // generic limit-reached warning, so the other window's balance stays visible.
    const hasWindowDetail = Boolean(ctx.usageData.fiveHourDetail || ctx.usageData.sevenDayDetail);
    if (balanceLabel && !hasWindowData) {
        return `${usageLabel} ${balanceLabel}`;
    }
    const timeFormat = normalizeTimeFormat(display?.timeFormat);
    const showResetLabel = display?.showResetLabel ?? true;
    const resetsKey = limitResetTimeFormat(timeFormat) === 'absolute' ? "format.resets" : "format.resetsIn";
    const usageCompact = display?.usageCompact ?? false;
    const usageValueMode = display?.usageValue ?? 'percent';
    if (isLimitReached(ctx.usageData) && !hasWindowDetail) {
        const limitTimeFormat = limitResetTimeFormat(timeFormat);
        const resetTime = ctx.usageData.fiveHour === 100
            ? formatResetTime(ctx.usageData.fiveHourResetAt, limitTimeFormat)
            : formatResetTime(ctx.usageData.sevenDayResetAt, limitTimeFormat);
        if (usageCompact) {
            return appendBalance(critical(`⚠ Limit${resetTime ? ` (${resetTime})` : ""}`, colors), balanceLabel);
        }
        const resetSuffix = resetTime
            ? showResetLabel
                ? ` (${t(resetsKey)} ${resetTime})`
                : ` (${resetTime})`
            : "";
        return appendBalance(`${usageLabel} ${critical(`⚠ ${t("status.limitReached")}${resetSuffix}`, colors)}`, balanceLabel);
    }
    const threshold = display?.usageThreshold ?? 0;
    const fiveHour = ctx.usageData.fiveHour;
    // showSevenDay:false drops the weekly window entirely (every 7d render path is
    // gated on `sevenDay !== null`), which the usage threshold can't do once 7d is
    // 100% used (the threshold is clamped to ≤100, so `100 >= 100` always shows it).
    const sevenDay = display?.showSevenDay === false ? null : ctx.usageData.sevenDay;
    const effectiveUsage = Math.max(fiveHour ?? 0, sevenDay ?? 0);
    if (effectiveUsage < threshold) {
        return balanceLabel ? `${usageLabel} ${balanceLabel}` : null;
    }
    const sevenDayThreshold = display?.sevenDayThreshold ?? 80;
    if (usageCompact) {
        const fiveHourPart = fiveHour !== null
            ? formatCompactWindowPart("5h", fiveHour, ctx.usageData.fiveHourResetAt, FIVE_HOUR_WINDOW_MS, timeFormat, colors, usageValueMode, ctx.usageData.fiveHourDetail ?? null)
            : null;
        const sevenDayPart = (sevenDay !== null && (fiveHour === null || sevenDay >= sevenDayThreshold))
            ? formatCompactWindowPart("7d", sevenDay, ctx.usageData.sevenDayResetAt, SEVEN_DAY_WINDOW_MS, timeFormat, colors, usageValueMode, ctx.usageData.sevenDayDetail ?? null)
            : null;
        if (fiveHourPart && sevenDayPart) {
            return appendBalance(`${fiveHourPart} | ${sevenDayPart}`, balanceLabel);
        }
        const compactLine = fiveHourPart ?? sevenDayPart;
        return compactLine ? appendBalance(compactLine, balanceLabel) : null;
    }
    const usageBarEnabled = display?.usageBarEnabled ?? true;
    // The seven-day window can hide its bar independently of the 5h bar.
    const sevenDayBarEnabled = usageBarEnabled && (display?.sevenDayBarEnabled ?? true);
    const barWidth = getAdaptiveBarWidth();
    if (fiveHour === null && sevenDay !== null) {
        const weeklyOnlyPart = formatUsageWindowPart({
            label: "7d",
            percent: sevenDay,
            resetAt: ctx.usageData.sevenDayResetAt,
            windowMs: SEVEN_DAY_WINDOW_MS,
            colors,
            usageBarEnabled: sevenDayBarEnabled,
            barWidth,
            timeFormat,
            showResetLabel,
            forceLabel: true,
            alignLabels,
            usageValueMode,
            detail: ctx.usageData.sevenDayDetail ?? null,
        });
        return appendBalance(`${usageLabel} ${weeklyOnlyPart}`, balanceLabel);
    }
    const fiveHourPart = formatUsageWindowPart({
        label: "5h",
        percent: fiveHour,
        resetAt: ctx.usageData.fiveHourResetAt,
        windowMs: FIVE_HOUR_WINDOW_MS,
        colors,
        usageBarEnabled,
        barWidth,
        timeFormat,
        showResetLabel,
        usageValueMode,
        // Force the "5h" label so the window reads symmetrically with the "7d"
        // part when concrete dollar details are shown (e.g. a provider balance).
        forceLabel: hasWindowDetail,
        detail: ctx.usageData.fiveHourDetail ?? null,
    });
    if (sevenDay !== null && sevenDay >= sevenDayThreshold) {
        const sevenDayPart = formatUsageWindowPart({
            label: "7d",
            percent: sevenDay,
            resetAt: ctx.usageData.sevenDayResetAt,
            windowMs: SEVEN_DAY_WINDOW_MS,
            colors,
            usageBarEnabled: sevenDayBarEnabled,
            barWidth,
            timeFormat,
            showResetLabel,
            forceLabel: true,
            alignLabels,
            usageValueMode,
            detail: ctx.usageData.sevenDayDetail ?? null,
        });
        return appendBalance(`${usageLabel} ${fiveHourPart} | ${sevenDayPart}`, balanceLabel);
    }
    return appendBalance(`${usageLabel} ${fiveHourPart}`, balanceLabel);
}
function appendBalance(line, balanceLabel) {
    return balanceLabel ? `${line} | ${balanceLabel}` : line;
}
function formatCompactWindowPart(windowLabel, percent, resetAt, windowMs, timeFormat, colors, usageValueMode = 'percent', detail = null) {
    const usageDisplay = formatUsageValue(percent, colors, usageValueMode, detail);
    const reset = formatWindowTime(resetAt, windowMs, timeFormat);
    const styledLabel = label(`${windowLabel}:`, colors);
    return reset
        ? `${styledLabel} ${usageDisplay} ${label(`(${reset})`, colors)}`
        : `${styledLabel} ${usageDisplay}`;
}
function formatUsagePercent(percent, colors, mode = 'percent') {
    if (percent === null) {
        return label("--", colors);
    }
    const color = getQuotaColor(percent, colors);
    const displayPercent = mode === 'remaining' ? Math.max(0, 100 - percent) : percent;
    return `${color}${displayPercent}%${RESET}`;
}
// Renders the value token for a usage window. When an external snapshot
// supplies a concrete `detail` string (e.g. "剩$6.37/$10"), it replaces the
// "NN%" token entirely but is still tinted by the quota color so it shifts
// green→yellow→red as the window fills. Falls back to the percentage display
// when no detail is provided.
function formatUsageValue(percent, colors, mode = 'percent', detail) {
    if (detail) {
        return `${getQuotaColor(percent ?? 0, colors)}${detail}${RESET}`;
    }
    return formatUsagePercent(percent, colors, mode);
}
function formatUsageWindowPart({ label: windowLabel, labelKey, percent, resetAt, windowMs, colors, usageBarEnabled, barWidth, timeFormat = 'relative', showResetLabel, forceLabel = false, alignLabels = false, usageValueMode = 'percent', detail = null, }) {
    const usageDisplay = formatUsageValue(percent, colors, usageValueMode, detail);
    const reset = formatWindowTime(resetAt, windowMs, timeFormat);
    const styledLabel = labelKey
        ? progressLabel(labelKey, colors, alignLabels)
        : label(windowLabel, colors);
    const showResetWording = timeFormat !== 'elapsed' && timeFormat !== 'elapsedAndAbsolute';
    const resetsKey = timeFormat === 'absolute' ? "format.resets" : "format.resetsIn";
    const resetSuffix = reset
        ? showResetLabel && showResetWording
            ? `(${t(resetsKey)} ${reset})`
            : `(${reset})`
        : "";
    if (usageBarEnabled) {
        const body = resetSuffix
            ? `${quotaBar(percent ?? 0, barWidth, colors)} ${usageDisplay} ${resetSuffix}`
            : `${quotaBar(percent ?? 0, barWidth, colors)} ${usageDisplay}`;
        return forceLabel ? `${styledLabel} ${body}` : body;
    }
    return resetSuffix
        ? `${styledLabel} ${usageDisplay} ${resetSuffix}`
        : `${styledLabel} ${usageDisplay}`;
}
function normalizeTimeFormat(value) {
    if (value === 'absolute'
        || value === 'both'
        || value === 'elapsed'
        || value === 'elapsedAndAbsolute') {
        return value;
    }
    return 'relative';
}
function limitResetTimeFormat(timeFormat) {
    if (timeFormat === 'elapsedAndAbsolute') {
        return 'absolute';
    }
    if (timeFormat === 'elapsed') {
        return 'relative';
    }
    return timeFormat;
}
function formatWindowTime(resetAt, windowMs, timeFormat) {
    if (timeFormat === 'elapsed') {
        return formatElapsedWindow(resetAt, windowMs);
    }
    if (timeFormat === 'elapsedAndAbsolute') {
        const elapsed = formatElapsedWindow(resetAt, windowMs);
        const absolute = formatResetTime(resetAt, 'absolute');
        if (elapsed && absolute) {
            return `${elapsed}, ${absolute}`;
        }
        return elapsed || absolute;
    }
    return formatResetTime(resetAt, timeFormat);
}
function formatElapsedWindow(resetAt, windowMs) {
    if (!resetAt) {
        return '';
    }
    const windowStart = resetAt.getTime() - windowMs;
    const rawElapsed = ((Date.now() - windowStart) / windowMs) * 100;
    const elapsed = Math.max(0, Math.min(100, Math.round(rawElapsed)));
    return `${elapsed}% elapsed`;
}
//# sourceMappingURL=usage.js.map