export function quizModuleId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("cmid")
      ?? (parsed.pathname.includes("/mod/quiz/view.php") ? parsed.searchParams.get("id") ?? undefined : undefined);
  } catch {
    return undefined;
  }
}

export function isAttemptForTarget(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const currentId = quizModuleId(currentUrl);
    const targetId = quizModuleId(targetUrl);
    return current.pathname.includes("/mod/quiz/attempt.php") && Boolean(currentId && targetId && currentId === targetId);
  } catch {
    return false;
  }
}

export function isReviewForTarget(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const currentId = quizModuleId(currentUrl);
    const targetId = quizModuleId(targetUrl);
    return current.pathname.includes("/mod/quiz/review.php") && Boolean(currentId && targetId && currentId === targetId);
  } catch {
    return false;
  }
}

export function nextReviewPageUrl(document: Document, currentUrl: string): string | undefined {
  const candidates = document.querySelectorAll<HTMLAnchorElement>('a.mod_quiz-next-nav[href], a[rel="next"][href]');
  for (const candidate of candidates) {
    try {
      const next = new URL(candidate.href || candidate.getAttribute("href") || "", currentUrl);
      if (!next.pathname.includes("/mod/quiz/review.php") || next.href === currentUrl) continue;
      if (quizModuleId(next.href) !== quizModuleId(currentUrl)) continue;
      return next.href;
    } catch { /* Bỏ qua liên kết điều hướng không hợp lệ. */ }
  }
  return undefined;
}
