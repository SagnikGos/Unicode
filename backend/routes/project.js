const express = require('express');
const bcrypt = require('bcryptjs');
const Project = require('../models/project.js');
const router = express.Router();

// Join or Create a Project
router.post('/join', async (req, res) => {
  const { projectId, password } = req.body;

  try {
    let project = await Project.findOne({ projectId });

    if (project) {
      const isMatch = await bcrypt.compare(password, project.password);
      if (!isMatch) return res.status(400).json({ msg: 'Invalid project credentials' });
    } else {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      project = new Project({ projectId, password: hashedPassword });
      await project.save();
    }

    res.json({ projectId });
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// Get Code for Project
router.get('/:projectId', async (req, res) => {
  try {
    const project = await Project.findOne({ projectId: req.params.projectId });
    if (!project) return res.status(404).json({ msg: 'Project not found' });

    res.json({ code: project.code });
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// Update Code
router.post('/update', async (req, res) => {
  const { projectId, code } = req.body;

  try {
    const project = await Project.findOneAndUpdate({ projectId }, { code }, { new: true });
    if (!project) return res.status(404).json({ msg: 'Project not found' });

    res.json({ success: true });
  } catch (err) {
    res.status(500).send('Server error');
  }
});

module.exports = router;
