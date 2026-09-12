// Genre list mirrored from server/index.js — keep the two in sync.
// (The server needs its own copy because it does not go through the bundler.)
export const GENRES = [
  { id: "music", name: "Music", color: "#8b5cf6", query: "Today's Top Hits" },
  { id: "live", name: "Live Events", color: "#7c2bff", query: "live concert hits" },
  { id: "foryou", name: "Made For You", color: "#6d28d9", query: "pop mix hits" },
  { id: "new", name: "New Releases", color: "#a855f7", query: "new music friday" },
  { id: "desi", name: "Desi", color: "#c026d3", query: "desi hits" },
  { id: "pop", name: "Pop", color: "#9333ea", query: "pop hits" },
  { id: "hiphop", name: "Hip-Hop", color: "#5b21b6", query: "hip hop rap caviar" },
  { id: "punjabi", name: "Punjabi", color: "#d946ef", query: "punjabi hits" },
  { id: "charts", name: "Charts", color: "#9b6bb0", query: "top songs global" },
  { id: "educational", name: "Educational", color: "#7e22ce", query: "study music focus" },
  { id: "documentary", name: "Documentary", color: "#4c1d95", query: "documentary soundtrack" },
  { id: "comedy", name: "Comedy", color: "#a21caf", query: "comedy songs" },
  { id: "rock", name: "Rock", color: "#7f1d9b", query: "rock hits" },
  { id: "rnb", name: "R&B", color: "#6a1b9a", query: "r&b soul hits" },
  { id: "electronic", name: "Electronic", color: "#6366f1", query: "electronic dance hits" },
  { id: "indie", name: "Indie", color: "#5c4b8a", query: "indie pop hits" },
  { id: "latin", name: "Latin", color: "#b23ab2", query: "latin hits" },
  { id: "kpop", name: "K-Pop", color: "#e879f9", query: "k-pop hits" },
  { id: "country", name: "Country", color: "#8d6e9b", query: "country hits" },
  { id: "metal", name: "Metal", color: "#3b0764", query: "metal hits" },
  { id: "jazz", name: "Jazz", color: "#553c7b", query: "jazz classics" },
  { id: "classical", name: "Classical", color: "#4a3760", query: "classical music" },
  { id: "bollywood", name: "Bollywood", color: "#c837ab", query: "bollywood hits" },
  { id: "pakistan", name: "Pakistani", color: "#7b3fa0", query: "pakistani hits" },
  { id: "chill", name: "Chill", color: "#8b7fd4", query: "chill hits lo-fi" },
  { id: "workout", name: "Workout", color: "#a020f0", query: "workout hits" },
  { id: "romance", name: "Romance", color: "#ad1497", query: "love songs" },
  { id: "party", name: "Party", color: "#bf3fd9", query: "party hits" },
  { id: "folk", name: "Folk", color: "#6d4c8b", query: "folk acoustic" },
  { id: "reggae", name: "Reggae", color: "#5e35b1", query: "reggae hits" },
];

export function genreById(id) {
  return GENRES.find((g) => g.id === id) || null;
}
