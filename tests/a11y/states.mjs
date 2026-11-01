// Plays the states of a rgaa.yaml in a browser (MAIR-317): opens the session of the state's
// user, loads the route (or the Storybook story) and runs its steps. The capture and the checks
// of each state are added on top of this (MAIR-318).
import { sessionCookie } from "./session.mjs";

const ACTION_TIMEOUT = 10_000;
const NAVIGATION_TIMEOUT = 30_000;

export function locate(page, locator) {
  const exact = locator.exact ?? false;
  if (locator.role) return page.getByRole(locator.role, locator.name ? { name: locator.name, exact } : {});
  if (locator.label) return page.getByLabel(locator.label, { exact });
  if (locator.text) return page.getByText(locator.text, { exact });
  if (locator.test_id) return page.getByTestId(locator.test_id);
  return page.locator(locator.selector);
}

export function stateUrl(state) {
  return state.story ? `/iframe.html?id=${encodeURIComponent(state.story)}&viewMode=story` : state.route;
}

async function select(page, { value, ...locator }) {
  const element = locate(page, locator);
  if ((await element.evaluate((node) => node.tagName)) === "SELECT") {
    await element.selectOption({ label: value });
    return;
  }
  // Custom listbox (lib-components): open it, then pick the option by its accessible name.
  await element.click();
  await page.getByRole("option", { name: value, exact: locator.exact ?? false }).click();
}

const ACTIONS = {
  click: (page, arg) => locate(page, arg).click(),
  hover: (page, arg) => locate(page, arg).hover(),
  fill: (page, { value, ...locator }) => locate(page, locator).fill(value),
  select,
  press: (page, key) => page.keyboard.press(key),
  wait_for: (page, arg) => locate(page, arg).waitFor({ state: "visible" }),
  wait_for_hidden: (page, arg) => locate(page, arg).waitFor({ state: "hidden" }),
  goto: (page, route) => page.goto(route, { waitUntil: "networkidle" }),
};

async function settle(page) {
  // Fonts and late requests (data loaded after hydration) must be in before a capture.
  await page.waitForLoadState("networkidle", { timeout: NAVIGATION_TIMEOUT }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready);
}

// Plays one state on a fresh context. `onReached(page)` runs once the steps are done and the page
// is settled; the context is closed afterwards. Returns { id, reached, error?, failed_step?, url }.
export async function playState(browser, scope, state, { onReached, onFailure } = {}) {
  const context = await browser.newContext({
    baseURL: scope.target,
    viewport: { width: 1280, height: 800 },
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
  });
  context.setDefaultTimeout(ACTION_TIMEOUT);
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
  if (state.as) await context.addCookies([sessionCookie(scope, state.as)]);

  const page = await context.newPage();
  const result = { id: state.id, reached: false };
  let step = -1;
  try {
    const response = await page.goto(stateUrl(state), { waitUntil: "networkidle" });
    if (response && response.status() >= 400) {
      throw new Error(`${stateUrl(state)} answered HTTP ${response.status()}`);
    }
    for (step = 0; step < (state.steps ?? []).length; step += 1) {
      const [action, arg] = Object.entries(state.steps[step])[0];
      await ACTIONS[action](page, arg);
    }
    await settle(page);
    result.reached = true;
    result.url = page.url();
    if (onReached) await onReached(page, result);
  } catch (error) {
    result.error = error.message.split("\n")[0];
    if (step >= 0 && step < (state.steps ?? []).length) result.failed_step = step;
    result.url = page.url();
    if (onFailure) await onFailure(page, result).catch(() => {});
  } finally {
    await context.close();
  }
  return result;
}
