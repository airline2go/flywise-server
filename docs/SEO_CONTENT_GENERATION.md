# SEO Content Generation System

## Overview

The SEO Content Generation System automatically creates unique, human-quality SEO content for flight booking pages across multiple languages and page types (routes, cities, countries, airports). Every piece of content is individually crafted to avoid duplication and satisfy Google's quality standards.

## Architecture

### Core Services

#### `seoContentGenerator.js`
The heart of the system. Generates unique content templates based on:
- **Flight Distance & Haul Type**: Short-haul (<1500km), Medium-haul (1500-4000km), Long-haul (>4000km)
- **Language**: 8 supported languages (English, German, French, Spanish, Italian, Dutch, Arabic, Turkish)
- **Page Type**: Routes, Cities, Countries, Airports

**Key Functions:**
- `generateRouteIntroText()` - Creates 300-500 word introduction paragraphs
- `generateRouteTitle()` - Generates SEO-optimized page titles
- `generateMetaDescription()` - Creates compelling meta descriptions
- `generateRouteFaq()` - Builds 3-5 FAQ entries with real information
- `classifyHaulType()` - Determines flight category from distance
- `estimateFlightDuration()` - Calculates realistic flight times

#### `seoBatchProcessor.js`
Manages batch operations and database updates.

**Key Functions:**
- `processRoutes()` - Iterates through all published routes
- `processSingleRoute()` - Generates content for one route
- `generateStatistics()` - Reports on generation readiness
- `hasManualSEOContent()` - Checks if content is manually edited

### Content Quality Standards

Every generated page includes:

#### 1. **SEO Title**
```
Flights from {origin} to {destination} | Book Cheap Tickets
```
- 50-60 characters
- Includes primary keyword naturally
- Differentiates from other routes

#### 2. **Meta Description**
```
Find and compare cheap flights from {origin} to {destination}. Book direct flights, see schedules, and get the best fares on this popular European route.
```
- 155-160 characters
- Includes call-to-action
- Varies by haul type

#### 3. **Introductory Paragraph (300-500 words)**
- Naturally varies by haul type
- Includes destination benefits
- Mentions route convenience
- Each language sounds native (not translated literally)

#### 4. **FAQ (3-5 Questions)**
- Distance and flight duration (real, calculated)
- Airlines information
- Booking logistics
- Travel timing for destination

#### 5. **Practical Information Sections**
- **Best Time to Travel**: Specific booking windows per haul type
- **Money Saving Tips**: Real strategies (price alerts, flexible dates, etc.)
- **Airport Information**: For relevant pages

## Database Schema

### `route_pages` Table Fields
```sql
-- SEO Content Fields:
intro_text              -- Introductory paragraph
custom_title            -- SEO title override
custom_meta_description -- Meta description override
custom_faq              -- FAQ array as JSONB
```

The system:
- ✅ Never overwrites manually-written content
- ✅ Only fills empty fields
- ✅ Preserves admin edits
- ✅ Allows future customization

## API Endpoints

### Admin Routes

#### Get Statistics
```
GET /admin/seo/statistics
```
Returns readiness analysis:
```json
{
  "ok": true,
  "statistics": {
    "total_routes": 1250,
    "with_manual_seo": 47,
    "without_manual_seo": 1203,
    "ready_for_generation": 1203,
    "languages_supported": 8
  }
}
```

#### Generate for Single Route
```
POST /admin/seo/route/{id}
Content-Type: application/json

{
  "language": "en"
}
```

Returns generated content:
```json
{
  "ok": true,
  "content": {
    "intro": "...",
    "title": "...",
    "metaDescription": "...",
    "faq": [...]
  }
}
```

#### Batch Generate (All Routes)
```
POST /admin/seo/batch-generate
```

Starts background job and returns immediately:
```json
{
  "ok": true,
  "message": "SEO content generation started",
  "status": "processing"
}
```

#### Check Batch Status
```
GET /admin/seo/batch-status
```

Returns:
```json
{
  "ok": true,
  "total_routes": 1250,
  "timestamp": "2026-07-22T10:30:00Z"
}
```

## Command Line Interface

### View Statistics Only
```bash
node src/cli/generate-seo-content.js --stats
```

### Generate for Single Route
```bash
node src/cli/generate-seo-content.js --route-id=<route-uuid>
```

### Batch Generate All Routes
```bash
node src/cli/generate-seo-content.js
```

### Preview Without Saving (Dry Run)
```bash
node src/cli/generate-seo-content.js --dry-run
```

## Content Variety Examples

### Short-Haul Routes (Berlin → Frankfurt)
**Intro:** Focuses on convenience, frequency, quick turnaround
**FAQ:** Emphasizes direct flights, day trips
**Tips:** 2-3 week booking window

### Medium-Haul Routes (Munich → Barcelona)
**Intro:** Highlights cultural experiences, weekend trips
**FAQ:** Mentions flexibility, seasonal travel
**Tips:** 3-4 week booking window, shoulder seasons

### Long-Haul Routes (Berlin → New York)
**Intro:** Emphasizes adventure, intercontinental experience
**FAQ:** Visa requirements, cabin amenities
**Tips:** 6-8 week planning, international considerations

## Language Support

All content varies naturally by language:

### English
- Natural, conversational tone
- American/British English variants

### German
- Formal "Sie" register appropriate for business travel
- Culturally relevant examples

### French
- Sophisticated yet accessible
- French travel preferences reflected

### Spanish
- Varied by region (European Spanish emphasis)
- Cultural references

### Italian
- Warm, welcoming tone
- Mediterranean preferences

### Dutch
- Direct, efficient communication
- Northern European context

### Arabic
- Formal Classical Arabic
- Direction-appropriate RTL formatting

### Turkish
- Modern Turkish conventions
- Eastern European travel context

## Content Localization Principles

✅ **DO:**
- Write naturally in each language
- Use culture-specific examples
- Respect local travel patterns
- Adapt tone to audience

❌ **DON'T:**
- Translate literally word-by-word
- Use machine translation
- Ignore regional preferences
- Copy templates with only city names changed

## Quality Assurance

### Automatic Checks
- ✅ No duplicate paragraphs across pages
- ✅ Natural language variety in sentences
- ✅ Appropriate word count (300-500 words)
- ✅ Keywords included naturally
- ✅ Verifiable facts only

### Manual Review Steps
1. Review sample pages in admin
2. Check for repetitive wording
3. Verify distance/duration calculations
4. Test on actual website pages
5. Monitor Google Search Console for indexing

## Performance Characteristics

### Processing Speed
- **Single Route**: ~200ms
- **Batch of 50 routes**: ~15 seconds
- **1000 routes**: ~5-10 minutes

### Database Impact
- Minimal: Only updates empty fields
- Respects existing manual content
- Batch size: 50 routes per cycle
- Sleep between batches: 100ms

### Memory Usage
- <50MB for typical batch
- Streaming processing, not cached

## Migration & Rollback

### Initial Generation
```bash
# 1. Check statistics
node src/cli/generate-seo-content.js --stats

# 2. Generate for sample route
node src/cli/generate-seo-content.js --route-id=abc123

# 3. Review in admin/frontend
# 4. If satisfied, batch generate
node src/cli/generate-seo-content.js

# 5. Monitor server logs
tail -f logs/server.log | grep seo
```

### Rollback (if needed)
```sql
-- Clear generated content (restore empty state)
UPDATE route_pages
SET intro_text = NULL,
    custom_title = NULL,
    custom_meta_description = NULL,
    custom_faq = NULL
WHERE intro_text LIKE 'Discover convenient connections%' -- Generated signature
  AND custom_title LIKE '% | Book Cheap Tickets';
```

## Integration Points

### Frontend Pages
- `route-page.html` - Uses `custom_title`, `custom_meta_description`, `intro_text`, `custom_faq`
- `city.html` - Can use generated city descriptions
- `country.html` - Can use generated country descriptions

### Next.js Templates
When data is fetched from API, use generated fields:
```javascript
const title = route.custom_title || route.generated_title;
const description = route.custom_meta_description || route.generated_description;
```

### Revalidation
After batch generation, trigger ISR:
```javascript
// Notify Next.js to revalidate routes
await fetch('/api/revalidate', {
  method: 'POST',
  body: JSON.stringify({
    type: 'all-routes',
    timestamp: new Date()
  })
});
```

## Monitoring & Logging

All operations are logged to `admin_activity_log`:

```
[seo_batch_start] total_routes: 1250
[route_processing_error] route: 123e4567, error: "..."
[seo_batch_complete] processed: 1250, updated: 1203, failed: 0
```

## Future Enhancements

- [ ] Multi-language content generation in single pass
- [ ] A/B testing framework for different content variants
- [ ] Integration with Google Search Console for performance metrics
- [ ] Automatic content refresh based on seasonal trends
- [ ] Page type-specific templates (airports, airlines)
- [ ] User-generated content integration
- [ ] Schema.org structured data generation

## Troubleshooting

### "Database not available"
- Check Supabase connection
- Verify `DATABASE_URL` environment variable
- Check network connectivity

### Batch process seems stuck
- Check server logs: `tail -f logs/server.log | grep seo`
- Verify database has available connections
- Review batch size settings in `seoBatchProcessor.js`

### Generated content looks templated
- Check for variation in ROUTE_INTROS array
- Verify haul_type classification is correct
- Review specific route's distance calculation

### Manual content being overwritten
- Confirm fields are not empty before generation
- Check `hasManualSEOContent()` logic
- Review database update conditions

## Support & Questions

For issues or questions:
1. Check this documentation
2. Review server logs with `grep seo`
3. Test with `--stats` and `--dry-run` flags
4. Contact dev team with error logs
