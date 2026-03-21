export interface FieldMapping {
  keywords: string[];
  fakerMethod: string;
  schemaType?: string;
  minScore: number;
  format?: string;
  trueProbability?: number;
  fakerArgs?: Record<string, unknown>;
}

// ── Identity & Auth ─────────────────────────────────────────────────
const identity: FieldMapping[] = [
  {
    keywords: ["email"],
    fakerMethod: "internet.email",
    schemaType: "string",
    minScore: 0.6,
    format: "email",
  },
  {
    keywords: ["username", "user_name", "login", "handle"],
    fakerMethod: "internet.username",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["password", "passwd", "secret"],
    fakerMethod: "internet.password",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["token", "api_key", "apikey", "access_token", "refresh_token"],
    fakerMethod: "string.alphanumeric",
    schemaType: "string",
    minScore: 0.8,
  },
];

// ── Person ──────────────────────────────────────────────────────────
const person: FieldMapping[] = [
  {
    keywords: ["first_name", "firstname", "given_name", "forename"],
    fakerMethod: "person.firstName",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["last_name", "lastname", "surname", "family_name"],
    fakerMethod: "person.lastName",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: [
      "full_name",
      "fullname",
      "display_name",
      "displayname",
      "full_name",
    ],
    fakerMethod: "person.fullName",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["name"],
    fakerMethod: "person.fullName",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["middle_name", "middlename"],
    fakerMethod: "person.middleName",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["prefix", "honorific", "salutation"],
    fakerMethod: "person.prefix",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["suffix"],
    fakerMethod: "person.suffix",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["gender", "sex"],
    fakerMethod: "person.sex",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["bio", "biography"],
    fakerMethod: "lorem.paragraph",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: [
      "job_title",
      "jobtitle",
      "position",
      "occupation",
      "job",
      "role",
    ],
    fakerMethod: "person.jobTitle",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["job_area", "department", "division", "team"],
    fakerMethod: "person.jobArea",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["zodiac", "zodiac_sign"],
    fakerMethod: "person.zodiacSign",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Contact ─────────────────────────────────────────────────────────
const contact: FieldMapping[] = [
  {
    keywords: [
      "phone",
      "mobile",
      "cell",
      "tel",
      "telephone",
      "cellphone",
      "fax",
    ],
    fakerMethod: "phone.number",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["imei"],
    fakerMethod: "phone.imei",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Address/Location ────────────────────────────────────────────────
const address: FieldMapping[] = [
  {
    keywords: ["street", "street_address"],
    fakerMethod: "location.streetAddress",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["address", "mailing_address", "postal_address"],
    fakerMethod: "location.streetAddress",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["city", "town"],
    fakerMethod: "location.city",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["state", "province", "region"],
    fakerMethod: "location.state",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["country"],
    fakerMethod: "location.country",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["country_code", "countrycode"],
    fakerMethod: "location.countryCode",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["county"],
    fakerMethod: "location.county",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["continent"],
    fakerMethod: "location.continent",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["zip", "zipcode", "zip_code", "postal", "postal_code"],
    fakerMethod: "location.zipCode",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["latitude", "lat"],
    fakerMethod: "location.latitude",
    schemaType: "number",
    minScore: 0.6,
  },
  {
    keywords: ["longitude", "lng", "lon", "long"],
    fakerMethod: "location.longitude",
    schemaType: "number",
    minScore: 0.6,
  },
  {
    keywords: ["timezone", "time_zone", "tz"],
    fakerMethod: "location.timeZone",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["building_number"],
    fakerMethod: "location.buildingNumber",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Internet/Network ────────────────────────────────────────────────
const internet: FieldMapping[] = [
  {
    keywords: ["url", "website", "link", "href", "homepage", "webpage"],
    fakerMethod: "internet.url",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: [
      "avatar",
      "photo_url",
      "profile_image",
      "image_url",
      "picture",
      "thumbnail",
      "icon",
    ],
    fakerMethod: "image.avatar",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["domain", "hostname", "domain_name"],
    fakerMethod: "internet.domainName",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["ip", "ip_address", "ipaddress", "ipv4"],
    fakerMethod: "internet.ipv4",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["ipv6"],
    fakerMethod: "internet.ipv6",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["mac", "mac_address"],
    fakerMethod: "internet.mac",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["user_agent", "useragent"],
    fakerMethod: "internet.userAgent",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["port"],
    fakerMethod: "internet.port",
    schemaType: "number",
    minScore: 0.9,
  },
  {
    keywords: ["protocol"],
    fakerMethod: "internet.protocol",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── IDs & Identifiers ──────────────────────────────────────────────
const ids: FieldMapping[] = [
  {
    keywords: ["uuid", "guid"],
    fakerMethod: "string.uuid",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["sku"],
    fakerMethod: "string.alphanumeric",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["slug"],
    fakerMethod: "lorem.slug",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["isbn"],
    fakerMethod: "commerce.isbn",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["vin"],
    fakerMethod: "vehicle.vin",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["iban"],
    fakerMethod: "finance.iban",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["bic", "swift"],
    fakerMethod: "finance.bic",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["ssn", "social_security"],
    fakerMethod: "string.numeric",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Text/Content ────────────────────────────────────────────────────
const text: FieldMapping[] = [
  {
    keywords: [
      "description",
      "desc",
      "summary",
      "overview",
      "about",
      "excerpt",
    ],
    fakerMethod: "lorem.paragraph",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["content", "body", "text", "message"],
    fakerMethod: "lorem.paragraphs",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["title", "heading", "subject", "headline"],
    fakerMethod: "lorem.sentence",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["tag", "label", "category", "keyword"],
    fakerMethod: "lorem.word",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["comment", "note", "remark", "feedback", "review"],
    fakerMethod: "lorem.sentence",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["sentence"],
    fakerMethod: "lorem.sentence",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["paragraph"],
    fakerMethod: "lorem.paragraph",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["word"],
    fakerMethod: "lorem.word",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Business/Commerce ───────────────────────────────────────────────
const business: FieldMapping[] = [
  {
    keywords: ["company", "organization", "org", "employer", "brand"],
    fakerMethod: "company.name",
    schemaType: "string",
    minScore: 0.6,
  },
  {
    keywords: ["product", "product_name", "item_name"],
    fakerMethod: "commerce.productName",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: [
      "price",
      "amount",
      "cost",
      "fee",
      "salary",
      "wage",
      "total",
      "subtotal",
      "balance",
      "revenue",
      "income",
    ],
    fakerMethod: "commerce.price",
    minScore: 0.6,
  },
  {
    keywords: ["currency", "currency_code"],
    fakerMethod: "finance.currencyCode",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["currency_name"],
    fakerMethod: "finance.currencyName",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["currency_symbol"],
    fakerMethod: "finance.currencySymbol",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["account_number", "account_no"],
    fakerMethod: "finance.accountNumber",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["credit_card", "card_number"],
    fakerMethod: "finance.creditCardNumber",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["cvv"],
    fakerMethod: "finance.creditCardCVV",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["transaction_type"],
    fakerMethod: "finance.transactionType",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Date/Time ───────────────────────────────────────────────────────
const dateTime: FieldMapping[] = [
  {
    keywords: [
      "created_at",
      "createdat",
      "creation_date",
      "date_created",
      "createddate",
    ],
    fakerMethod: "date.recent",
    schemaType: "string",
    minScore: 0.6,
    format: "date-time",
  },
  {
    keywords: [
      "updated_at",
      "updatedat",
      "modified_at",
      "modifiedat",
      "date_updated",
      "last_modified",
      "date_modified",
    ],
    fakerMethod: "date.recent",
    schemaType: "string",
    minScore: 0.6,
    format: "date-time",
  },
  {
    keywords: ["deleted_at", "deletedat"],
    fakerMethod: "date.recent",
    schemaType: "string",
    minScore: 0.6,
    format: "date-time",
  },
  {
    keywords: ["published_at", "publishedat", "publish_date"],
    fakerMethod: "date.recent",
    schemaType: "string",
    minScore: 0.6,
    format: "date-time",
  },
  {
    keywords: ["expires_at", "expiresat", "expiration", "expiry"],
    fakerMethod: "date.future",
    schemaType: "string",
    minScore: 0.6,
    format: "date-time",
  },
  {
    keywords: ["birthday", "date_of_birth", "dob", "birthdate", "born"],
    fakerMethod: "date.birthdate",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["start_date", "begin_date"],
    fakerMethod: "date.past",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["end_date", "due_date", "deadline"],
    fakerMethod: "date.future",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["timestamp", "ts"],
    fakerMethod: "date.recent",
    schemaType: "string",
    minScore: 0.8,
  },
];

// ── Color ───────────────────────────────────────────────────────────
const color: FieldMapping[] = [
  {
    keywords: ["color", "colour"],
    fakerMethod: "color.human",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["hex_color", "hexcolor"],
    fakerMethod: "color.rgb",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Numeric Semantics ───────────────────────────────────────────────
const numeric: FieldMapping[] = [
  {
    keywords: ["age"],
    fakerMethod: "number.int",
    schemaType: "number",
    minScore: 0.8,
    fakerArgs: { min: 18, max: 80 },
  },
  {
    keywords: ["rating", "score", "stars"],
    fakerMethod: "number.int",
    schemaType: "number",
    minScore: 0.8,
    fakerArgs: { min: 1, max: 5 },
  },
  {
    keywords: ["count", "quantity", "qty"],
    fakerMethod: "number.int",
    schemaType: "number",
    minScore: 0.8,
    fakerArgs: { min: 1, max: 100 },
  },
  {
    keywords: ["percentage", "percent"],
    fakerMethod: "number.int",
    schemaType: "number",
    minScore: 0.8,
    fakerArgs: { min: 0, max: 100 },
  },
  {
    keywords: ["weight"],
    fakerMethod: "number.float",
    schemaType: "number",
    minScore: 0.8,
    fakerArgs: { min: 0.1, max: 200 },
  },
  {
    keywords: ["height"],
    fakerMethod: "number.int",
    schemaType: "number",
    minScore: 0.8,
    fakerArgs: { min: 100, max: 220 },
  },
  {
    keywords: ["width", "length", "depth"],
    fakerMethod: "number.int",
    schemaType: "number",
    minScore: 0.8,
    fakerArgs: { min: 1, max: 1000 },
  },
  {
    keywords: ["priority", "order", "rank", "level"],
    fakerMethod: "number.int",
    schemaType: "number",
    minScore: 0.8,
    fakerArgs: { min: 1, max: 10 },
  },
  {
    keywords: ["version"],
    fakerMethod: "system.semver",
    schemaType: "string",
    minScore: 0.8,
  },
];

// ── Boolean Semantics (weighted) ────────────────────────────────────
const booleans: FieldMapping[] = [
  {
    keywords: ["is_active", "isactive", "active", "enabled", "is_enabled"],
    fakerMethod: "datatype.boolean",
    schemaType: "boolean",
    minScore: 0.6,
    trueProbability: 0.9,
  },
  {
    keywords: ["is_deleted", "isdeleted", "deleted"],
    fakerMethod: "datatype.boolean",
    schemaType: "boolean",
    minScore: 0.6,
    trueProbability: 0.05,
  },
  {
    keywords: ["is_archived", "isarchived", "archived"],
    fakerMethod: "datatype.boolean",
    schemaType: "boolean",
    minScore: 0.6,
    trueProbability: 0.1,
  },
  {
    keywords: [
      "is_verified",
      "isverified",
      "verified",
      "confirmed",
      "is_confirmed",
    ],
    fakerMethod: "datatype.boolean",
    schemaType: "boolean",
    minScore: 0.6,
    trueProbability: 0.8,
  },
  {
    keywords: ["is_admin", "isadmin", "admin"],
    fakerMethod: "datatype.boolean",
    schemaType: "boolean",
    minScore: 0.6,
    trueProbability: 0.1,
  },
  {
    keywords: ["is_public", "ispublic", "public", "visible", "is_visible"],
    fakerMethod: "datatype.boolean",
    schemaType: "boolean",
    minScore: 0.6,
    trueProbability: 0.7,
  },
  {
    keywords: ["is_read", "isread", "read", "seen", "is_seen"],
    fakerMethod: "datatype.boolean",
    schemaType: "boolean",
    minScore: 0.6,
    trueProbability: 0.6,
  },
  {
    keywords: ["is_default", "isdefault"],
    fakerMethod: "datatype.boolean",
    schemaType: "boolean",
    minScore: 0.8,
    trueProbability: 0.1,
  },
  {
    keywords: ["is_required", "isrequired", "required", "mandatory"],
    fakerMethod: "datatype.boolean",
    schemaType: "boolean",
    minScore: 0.6,
    trueProbability: 0.5,
  },
  {
    keywords: ["is_featured", "isfeatured", "featured", "promoted"],
    fakerMethod: "datatype.boolean",
    schemaType: "boolean",
    minScore: 0.8,
    trueProbability: 0.15,
  },
  {
    keywords: ["available", "in_stock"],
    fakerMethod: "datatype.boolean",
    schemaType: "boolean",
    minScore: 0.8,
    trueProbability: 0.85,
  },
];

// ── File/System ─────────────────────────────────────────────────────
const fileSystem: FieldMapping[] = [
  {
    keywords: ["filename", "file_name"],
    fakerMethod: "system.fileName",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: [
      "file_type",
      "filetype",
      "mime_type",
      "mimetype",
      "content_type",
    ],
    fakerMethod: "system.mimeType",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["file_ext", "extension"],
    fakerMethod: "system.fileExt",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["file_path", "filepath", "path"],
    fakerMethod: "system.filePath",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["cron", "cron_expression"],
    fakerMethod: "system.cron",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["semver"],
    fakerMethod: "system.semver",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Airline (niche) ─────────────────────────────────────────────────
const airline: FieldMapping[] = [
  {
    keywords: ["aircraft_type", "airplane", "aircraft"],
    fakerMethod: "airline.aircraftType",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["flight_number", "flight"],
    fakerMethod: "airline.flightNumber",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["record_locator", "booking_ref", "pnr"],
    fakerMethod: "airline.recordLocator",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["seat", "seat_number"],
    fakerMethod: "airline.seat",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Animal (niche) ──────────────────────────────────────────────────
const animal: FieldMapping[] = [
  {
    keywords: ["animal", "animal_type", "species"],
    fakerMethod: "animal.type",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["pet_name"],
    fakerMethod: "animal.petName",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["breed"],
    fakerMethod: "animal.dog",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["bird"],
    fakerMethod: "animal.bird",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["fish"],
    fakerMethod: "animal.fish",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["horse"],
    fakerMethod: "animal.horse",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["insect"],
    fakerMethod: "animal.insect",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Book (niche) ────────────────────────────────────────────────────
const book: FieldMapping[] = [
  {
    keywords: ["book_title"],
    fakerMethod: "book.title",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["author", "book_author", "writer"],
    fakerMethod: "book.author",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["genre", "book_genre"],
    fakerMethod: "book.genre",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["publisher", "publishing_house"],
    fakerMethod: "book.publisher",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["book_series", "series_name"],
    fakerMethod: "book.series",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Food (niche) ────────────────────────────────────────────────────
const food: FieldMapping[] = [
  {
    keywords: ["dish", "meal", "recipe_name"],
    fakerMethod: "food.dish",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["ingredient"],
    fakerMethod: "food.ingredient",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["spice"],
    fakerMethod: "food.spice",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["fruit"],
    fakerMethod: "food.fruit",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["vegetable"],
    fakerMethod: "food.vegetable",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["meat"],
    fakerMethod: "food.meat",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["food_description"],
    fakerMethod: "food.description",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["ethnic_category", "cuisine"],
    fakerMethod: "food.ethnicCategory",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Music (niche) ───────────────────────────────────────────────────
const music: FieldMapping[] = [
  {
    keywords: ["song", "song_name", "track", "track_name"],
    fakerMethod: "music.songName",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["album", "album_name"],
    fakerMethod: "music.album",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["artist", "musician", "band"],
    fakerMethod: "music.artist",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["music_genre"],
    fakerMethod: "music.genre",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Science (niche) ─────────────────────────────────────────────────
const science: FieldMapping[] = [];

// ── Vehicle (niche) ─────────────────────────────────────────────────
const vehicle: FieldMapping[] = [
  {
    keywords: ["vehicle", "vehicle_name"],
    fakerMethod: "vehicle.vehicle",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["vehicle_type"],
    fakerMethod: "vehicle.type",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["vehicle_manufacturer", "car_make"],
    fakerMethod: "vehicle.manufacturer",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["vehicle_model", "car_model"],
    fakerMethod: "vehicle.model",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["fuel", "fuel_type"],
    fakerMethod: "vehicle.fuel",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["bicycle"],
    fakerMethod: "vehicle.bicycle",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["vehicle_color", "car_color"],
    fakerMethod: "vehicle.color",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Git/Dev (niche) ─────────────────────────────────────────────────
const git: FieldMapping[] = [
  {
    keywords: ["branch", "branch_name", "git_branch"],
    fakerMethod: "git.branch",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["commit_sha", "commit_hash", "sha"],
    fakerMethod: "git.commitSha",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["commit_message"],
    fakerMethod: "git.commitMessage",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Database (niche) ────────────────────────────────────────────────
const database: FieldMapping[] = [
  {
    keywords: ["db_column", "column_name"],
    fakerMethod: "database.column",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["db_type", "column_type"],
    fakerMethod: "database.type",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["db_engine", "database_engine"],
    fakerMethod: "database.engine",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["collation"],
    fakerMethod: "database.collation",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["mongodb_id", "object_id"],
    fakerMethod: "database.mongodbObjectId",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Hacker/Tech (niche) ────────────────────────────────────────────
const hacker: FieldMapping[] = [
  {
    keywords: ["abbreviation", "tech_abbreviation"],
    fakerMethod: "hacker.abbreviation",
    schemaType: "string",
    minScore: 0.9,
  },
  {
    keywords: ["hacker_phrase", "tech_phrase"],
    fakerMethod: "hacker.phrase",
    schemaType: "string",
    minScore: 0.9,
  },
];

// ── Word/Lorem (domain) ────────────────────────────────────────────
const word: FieldMapping[] = [
  {
    keywords: ["adjective"],
    fakerMethod: "word.adjective",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["adverb"],
    fakerMethod: "word.adverb",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["noun"],
    fakerMethod: "word.noun",
    schemaType: "string",
    minScore: 0.8,
  },
  {
    keywords: ["verb"],
    fakerMethod: "word.verb",
    schemaType: "string",
    minScore: 0.8,
  },
];

export const ALL_FIELD_MAPPINGS: FieldMapping[] = [
  ...identity,
  ...person,
  ...contact,
  ...address,
  ...internet,
  ...ids,
  ...text,
  ...business,
  ...dateTime,
  ...color,
  ...numeric,
  ...booleans,
  ...fileSystem,
  ...airline,
  ...animal,
  ...book,
  ...food,
  ...music,
  ...science,
  ...vehicle,
  ...git,
  ...database,
  ...hacker,
  ...word,
];
