// --- File: models/project.js ---

const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema({
  // This stores the user-defined ID (e.g., "kikikuku")
  projectId: {
    type: String,
    required: true,
    unique: true,
    trim: true // Good practice
  },
  password: {
    type: String,
    required: true
  },
  code: { // Legacy? Yjs likely handles current code state.
    type: String,
    default: ''
  },
  // Array of users who have access
  users: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }]
}, {
    timestamps: true // Adds createdAt and updatedAt
});

module.exports = mongoose.model('Project', ProjectSchema);