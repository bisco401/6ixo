# 6ixo - Online Marketplace 💕

A modern, feature-rich online marketplace with live location tracking, real-time messaging, and intuitive swipe-based matching.

## 🌟 Features

### Core Dating Features
- **Swipe Discovery**: Tinder-style card stack with smooth swipe animations
- **Smart Matching**: Algorithm-based user matching with instant match notifications
- **Real-time Messaging**: Chat system with online/offline status indicators
- **User Profiles**: Comprehensive profiles with photos, bio, and interests

### Location Features
- **Live GPS Tracking**: Real-time location updates using HTML5 Geolocation
- **Distance-Based Matching**: Find people within your preferred distance range
- **Nearby Users**: Interactive map showing users in your area
- **Location Privacy**: User-controlled location sharing with distance filtering

### User Experience
- **Modern UI/UX**: Beautiful gradient design with smooth animations
- **Mobile-First**: Responsive design optimized for mobile devices
- **Progressive Web App**: Can be installed on mobile devices
- **Fast Loading**: Optimized performance with smooth transitions
 - **Profile Video (New)**: Upload a short 5–10 second clip to your profile with instant preview

## 🚀 Quick Start

1. **Open the App**: Simply open `index.html` in your web browser
2. **Allow Location**: Grant location permission for the best experience
3. **Create Account**: Sign up with your details
4. **Start Swiping**: Discover people nearby and start matching!

## 🧩 Supabase (Optional Backend)

This project can use Supabase for real email/password auth + profile persistence.

1. Set credentials in `supabase-config.js` (Project URL + anon key).
2. Serve locally (recommended): `python -m http.server 8000` → open `http://localhost:8000` (avoids `file://` CORS issues).
3. Create a `profiles` table + RLS in Supabase (SQL editor):

```sql
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text,
  last_name text,
  full_name text,
  age int,
  bio text,
  phone text,
  photo_url text,
  interests text[],
  city text,
  region text,
  country text,
  map_visible boolean default false,
  updated_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
for select using (auth.uid() = id);

create policy "profiles_insert_own" on public.profiles
for insert with check (auth.uid() = id);

create policy "profiles_update_own" on public.profiles
for update using (auth.uid() = id)
with check (auth.uid() = id);
```

Important: only use the anon key in the browser; keep RLS enabled.
In the app, Login/Signup use Supabase auth, and Profile → `Save Changes` upserts into `profiles` (Profile → `Sign out` signs out).

Example query (DevTools console after login):
```js
await app.supabase.from('profiles').select('full_name, city, country').limit(5);
```

## InstantMeet (Prototype)

This app can optionally use the Google Maps JavaScript API for map/location UX.

How to enable:
- Set your key in `google-config.js`
- In Google Cloud Console, enable Maps JavaScript API (and any others you use)
- Restrict the key to your domain/origin for security

## 📱 How to Use

### Getting Started
1. **Sign Up/Login**: Create your account or log in
2. **Location Permission**: Allow location access for distance-based matching
3. **Complete Profile**: Add your photo, bio, interests, and an optional short profile video

### Discovering People
- **Swipe Right**: Like someone (tap the heart button)
- **Swipe Left**: Pass on someone (tap the X button)
- **Card Interactions**: Drag cards left or right to swipe

### Messaging
- **View Matches**: Check your matches in the Matches tab
- **Start Chatting**: Tap on a match to open the chat
- **Real-time Chat**: Send and receive messages instantly

### Location Features
### Profile Video
- Go to the Profile tab and look for "Profile Video (5–10 seconds)"
- Click the file picker and choose a video between 5 and 10 seconds
- You'll see an instant preview; you can remove or replace it anytime
- Note: The video is stored for the current session only (no server). Persistence can be added with IndexedDB in the future.
- **Nearby Tab**: See people near you with exact distances
- **Distance Filter**: Adjust your search radius (1-50km)
- **Live Updates**: Your location updates automatically as you move

## 🛠️ Technical Details

### Built With
- **HTML5**: Semantic markup and modern APIs
- **CSS3**: Advanced styling with animations and gradients
- **Vanilla JavaScript**: Clean, efficient ES6+ code
- **Geolocation API**: Real-time location tracking
- **Local Storage**: Data persistence

### Browser Support
- Chrome 60+ ✅
- Firefox 55+ ✅
- Safari 12+ ✅
- Edge 79+ ✅

### Mobile Support
- iOS Safari ✅
- Android Chrome ✅
- Mobile responsive design ✅

## 🔧 Installation & Setup

### For Development
```bash
# Clone or download the project
cd dating-app

# Open in your preferred code editor
code .

# Start a local server (optional)
python -m http.server 8000
# or
npx serve .

# Open in browser
# Navigate to http://localhost:8000
```

### For Production
1. Upload all files to your web server
2. Ensure HTTPS is enabled for location services
3. Configure domain settings if needed

## 📂 Project Structure

```
dating-app/
├── index.html          # Main HTML file
├── styles.css          # All CSS styles
├── app.js             # Main JavaScript application
├── google-config.js    # Google Maps API key (client-side)
├── supabase-config.js  # Optional Supabase browser config
├── sw.js               # Service Worker (PWA, optional)
├── README.md          # This file
└── .github/
    └── copilot-instructions.md
```

## 🔐 Privacy & Security

### Location Privacy
- Location data is only used for distance calculations
- No location data is stored permanently
- Users can disable location sharing anytime
- Approximate distances shown (not exact coordinates)

### Data Handling
- All data is stored locally in browser
- No personal data transmitted to external servers
- Users have full control over their information

## 🎨 Customization

### Themes
The app uses CSS custom properties for easy theming:
```css
:root {
  --primary-color: #667eea;
  --secondary-color: #764ba2;
  --accent-color: #ff6b6b;
  --success-color: #4ecdc4;
}
```

### Distance Units
Change from kilometers to miles in the `calculateDistance` function.

## 📈 Future Enhancements

### Planned Features
- [ ] Video chat integration
- [ ] Advanced matching algorithms
- [ ] Social media integration
- [ ] Photo verification
- [ ] Premium features
- [ ] Push notifications

### Technical Improvements
- [ ] Backend API integration
- [ ] Real-time WebSocket messaging
- [ ] Database persistence
- [ ] User authentication with JWT
- [ ] Image upload and compression

## 🐛 Known Issues

- Location accuracy depends on device GPS
- Demo uses simulated users and responses
- Requires HTTPS for location services in production

## 💡 Tips for Best Experience

1. **Enable Location**: Allow location access for accurate distance matching
2. **Complete Profile**: Add photos and interests for better matches
3. **Be Active**: Regular usage improves match suggestions
4. **Stay Safe**: Meet in public places for first dates

## 🤝 Contributing

Feel free to fork this project and submit pull requests for improvements!

## 📄 License

This project is open source and available under the MIT License.

## 📞 Support

For questions or issues, please create an issue in the repository.

---

**Made with ❤️ for modern dating**

## Search engine optimization

Run `npm run seo:refresh` after changing published listing feeds. It generates HTML listing pages, category and country indexes with 36 listings per page, current inventory links on existing landing pages, and the canonical XML sitemap with listing images. The generator uses the main feed plus authoritative country feeds, excludes rejected/hidden/sold listings, applies image and availability corrections, and removes duplicate identities and source URLs. Existing listing URLs remain stable when titles change. Retired pages display an unavailable notice with `noindex` and leave the sitemap.

Numbered browsing pages (page 2 onward) use `noindex, follow` and are excluded from the sitemap so they do not become branded search sitelinks. They retain their own canonical URLs, working pagination and listing links, and remain crawlable in `robots.txt` so search engines can see the exclusion. Main category/country landing pages and every active individual listing remain indexable and in the sitemap. The audit follows pagination when checking that all listings are reachable. Google applies exclusions after recrawling; category links influence its automatic sitelink selection but do not guarantee a particular result.

Product offers use published prices and currencies. Unknown availability and condition are omitted; services, jobs and property listings use appropriate non-product entities. No reviews, ratings or seller details are invented. Imported listings link to their original source so visitors can confirm availability and contact the seller.

`npm run test:seo` checks metadata, canonical URLs, schema syntax, crawl rules, listing images, internal links, home-page reachability and sitemap dates. Regression tests cover pagination, source duplicates, unsafe input, URL stability, retirement and deterministic rebuilds. `data/seo-page-state.json` records content hashes so sitemap dates change only when the page changes. The SEO workflow rebuilds after existing inventory workflows complete and explicitly requests a GitHub Pages build before notifying IndexNow participants. CI verifies deployment and the public key directly through the GitHub Pages origin because Cloudflare blocks GitHub runner IPs; the custom domain Host header, SNI and TLS certificate checks are retained.

Submit `https://6ixo.com/sitemap.xml` in Google Search Console and Bing Webmaster Tools. The Google verification tag and IndexNow key are preserved. Use URL Inspection and the [Rich Results Test](https://search.google.com/test/rich-results) to check representative published pages. Google explains [sitemap submission and lastmod dates](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) and [product snippet eligibility](https://developers.google.com/search/docs/appearance/structured-data/product-snippet). Native database listings need a public server-rendered export before they can join this static inventory build.

## Escrow.com payments and 6ixo service fee

Eligible fixed-price items listed by registered 6ixo sellers can use hosted Escrow Pay. The minimum item price is 1,000 in CAD, USD, AUD, EUR or GBP. Imported ads, real estate, rentals and live auctions are excluded.

The buyer pays a separately disclosed **2% 6ixo service fee, minimum 20 and maximum 500 in the transaction currency**, plus the provider's fees. `ESCROW_POLICY` in `supabase/functions/_shared/escrow.ts` owns pricing. The service fee is a visible `broker_fee` payable to the API account; the saved seller receives the item amount. Escrow.com calculates its fees through `transaction/fees-summary` before checkout and confirms final payment-method charges in hosted checkout.

Checkout stays unavailable until the API account has a provider payout method. The readiness checks recheck the provider after at most 60 seconds, so saving a payout method needs no code change.

Both parties use their verified 6ixo account email with Escrow.com. The buyer reviews the quote and three-calendar-day inspection period before starting hosted checkout. Escrow.com holds funds and handles funding, shipment, receipt, acceptance, rejection, returns, cancellations and disbursements. The inspection period begins after confirmed delivery; provider terms govern automatic release and fee refunds. CAD funding uses bank wire transfers.

“My escrow deals” in Profile shows purchases and sales, resumes buyer checkout and refreshes authoritative provider status. A checkout redirect, webhook event name, browser state or screenshot never proves payment. Participant APIs return sanitized records; browser roles cannot access provider payloads, private emails or another buyer's checkout token. Seller/price/currency/fee values are obtained on the server. Database reservations prevent duplicate and competing checkouts, lock listing terms during an active escrow transaction, and retain ambiguous provider outcomes for reconciliation.

Deploy `create-escrow-transaction`, `escrow-webhook`, and `escrow-config`, including their shared modules. Use the existing `ESCROW_API_EMAIL`, `ESCROW_API_KEY`, `ESCROW_API_BASE_URL` and `ESCROW_WEBHOOK_TOKEN` secrets. Live base URL: `https://api.escrow.com/2017-09-01`; sandbox: `https://api.escrow-sandbox.com/2017-09-01`. Sandbox requires a separate provider account. Register `/functions/v1/escrow-webhook?token=<secret>` with Escrow.com using server credentials; never expose that URL/token to the browser. Webhook requests re-fetch provider transaction details before saving status.

For an existing production database, apply only `20261014153000_escrow_checkout_service_fee.sql` and `20261014160000_escrow_checkout_retry_guard.sql` after the existing `20260531100000_create_escrow_transactions.sql`. Do not push unrelated pending migrations. Test with `node --test scripts/escrow-checkout.test.mjs`.
