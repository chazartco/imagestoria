/**
 * The kinds of scene a picture can be filed under. The worker's vision model must choose one of these,
 * the server refuses anything else, and the page offers the same list when a person corrects a scene.
 * Keep the names short and lower case. Adding one is safe. Renaming one leaves old pictures under the old name
 * until they are read again.
 */
export const SCENES = [
  'beach', 'coast', 'mountains', 'forest', 'desert', 'lake or river', 'countryside', 'park or garden',
  'city street', 'architecture', 'landmark', 'interior', 'food and drink',
  'portrait', 'group of people', 'celebration', 'sport', 'pets', 'wildlife', 'vehicle',
  'night', 'sunset or sunrise', 'snow', 'underwater', 'art', 'document', 'object', 'other',
];
