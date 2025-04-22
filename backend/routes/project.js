const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator'); // For potential validation
const Project = require('../models/project'); // Correct path to your Project model
const authMiddleware = require('../middleware/auth'); // Import your auth middleware

const router = express.Router();

// @route   POST /api/projects/join
// @desc    Join an existing project or create a new one
// @access  Private
router.post(
    '/join',
    [
        authMiddleware, // Requires user to be logged in
        body('projectId', 'Project ID is required').not().isEmpty(),
        body('password', 'Password is required').not().isEmpty()
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { projectId, password } = req.body;
        const userId = req.user.id; // Get user ID from authenticated request

        try {
            let project = await Project.findOne({ projectId });

            if (project) {
                // Project exists, check password
                const isMatch = await bcrypt.compare(password, project.password);
                if (!isMatch) {
                    return res.status(400).json({ errors: [{ msg: 'Invalid project credentials' }] });
                }
                // **Optional: Add user to existing project if they join successfully?**
                // If you want users to be added just by knowing the password, uncomment below.
                // Be careful with security implications. Usually, explicit invites are better.
                /*
                if (!project.users.includes(userId)) {
                    project.users.push(userId);
                    await project.save();
                    console.log(`User ${userId} added to existing project ${projectId} by joining.`);
                }
                */
                console.log(`User ${userId} successfully joined existing project ${projectId}`);

            } else {
                // Project doesn't exist, create it
                console.log(`Project ${projectId} not found. Creating new project for user ${userId}.`);
                const salt = await bcrypt.genSalt(10);
                const hashedPassword = await bcrypt.hash(password, salt);

                project = new Project({
                    projectId,
                    password: hashedPassword,
                    code: '// Start coding here!', // Default initial code
                    // **** Add the creator to the users array ****
                    users: [userId]
                });
                await project.save();
                console.log(`New project ${projectId} created with user ${userId}.`);
            }

            // Respond with the projectId, indicating success
            res.json({ projectId });

        } catch (err) {
            console.error("Error in /join route:", err.message);
            res.status(500).send('Server error');
        }
    }
);

// @route   GET /api/projects/:projectId
// @desc    Get project details (e.g., initial code - less relevant with Yjs)
// @access  Private (User must be part of the project)
router.get(
    '/:projectId',
    authMiddleware, // Requires user to be logged in
    async (req, res) => {
        const requestedProjectId = req.params.projectId;
        const userId = req.user.id;

        try {
            const project = await Project.findOne({ projectId: requestedProjectId });

            if (!project) {
                return res.status(404).json({ msg: 'Project not found' });
            }

            // **Authorization Check:** Ensure the requesting user is in the project's users array
            if (!project.users.includes(userId)) {
                 console.warn(`User ${userId} forbidden from accessing project ${requestedProjectId} via GET request.`);
                 return res.status(403).json({ msg: 'Forbidden: User not part of this project' });
             }

            // If authorized, return relevant info (maybe just confirmation, or initial code if needed)
            // Note: Returning project.code might be less useful if Yjs handles the state.
            // You might return other project metadata instead.
            res.json({
                 projectId: project.projectId,
                 // code: project.code // Decide if you still need to send this
                 memberCount: project.users.length // Example metadata
             });

        } catch (err) {
            console.error(`Error fetching project ${requestedProjectId}:`, err.message);
            res.status(500).send('Server error');
        }
    }
);

// Note: The POST /api/projects/update route has been removed as it conflicts
// with Yjs handling real-time updates and persistence.

module.exports = router;