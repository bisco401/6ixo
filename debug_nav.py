from playwright.sync_api import sync_playwright
from pathlib import Path
import time

path = Path('/Users/ll/dating/index.html').resolve()
url = f'file://{path}'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(url)
    # Wait a bit for scripts to run
    page.wait_for_timeout(1500)
    def get_active():
        return page.eval_on_selector_all('.content-screen', 'els => els.map(el => ({id: el.id, active: el.classList.contains("active")}))')
    print('Initial active:', get_active())
    # click marketplace nav button
    page.click('[data-screen="marketplace"]')
    page.wait_for_timeout(500)
    print('After marketplace:', get_active())
    # click home nav button
    page.click('[data-screen="home"]')
    page.wait_for_timeout(500)
    print('After home click:', get_active())
    browser.close()
