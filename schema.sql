CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league TEXT NOT NULL,
  match_date TEXT NOT NULL,
  date_display TEXT NOT NULL,
  kickoff TEXT NOT NULL,
  home TEXT NOT NULL,
  away TEXT NOT NULL,
  handicap TEXT NOT NULL,
  favorite TEXT NOT NULL,
  prediction TEXT NOT NULL,
  score TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(match_date, kickoff);
CREATE INDEX IF NOT EXISTS idx_matches_league ON matches(league);
