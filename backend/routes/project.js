// --- File: routes/project.js ---

const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { body, validationResult } = require('express-validator');
const Project = require('../models/project'); // Adjust path if needed
const authMiddleware = require('../middleware/auth'); // Adjust path if needed

const router = express.Router();

// @route   POST /api/projects/join
// @desc    Join or Create a project using the user-defined projectId
// @access  Private
router.post(
    '/join',
    [
        authMiddleware,
        body('projectId', 'Project ID/Name is required').not().isEmpty(),
        body('password', 'Password is required').not().isEmpty()
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        // User input corresponds to the 'projectId' field in the schema
        const { projectId: userInputProjectId, password } = req.body;
        const userId = req.user.id;

        try {
            let project;
            let needsSave = false;
            let isNew = false;

            // --- CORRECTED LOGIC to use 'projectId' field from schema ---
            // Find existing project using the user-provided projectId field
            project = await Project.findOne({ projectId: userInputProjectId });

            if (project) {
                // Project Found - Check password
                console.log(`[Project Join/Create] Found existing project by projectId: ${userInputProjectId}`);
                const isMatch = await bcrypt.compare(password, project.password);
                if (!isMatch) {
                    return res.status(400).json({ errors: [{ msg: 'Invalid project credentials' }] });
                }
                // Add user to 'users' array if not already present
                if (!project.users?.includes(userId)) {
                    console.log(`[Project Join/Create] Adding user ${userId} to project ${project._id} (user input: ${userInputProjectId}).`);
                    project.users.push(userId);
                    needsSave = true;
                } else {
                     console.log(`[Project Join/Create] User ${userId} already a member of project ${project._id} (user input: ${userInputProjectId}).`);
                }

            } else {
                // Project Not Found - Create New Project
                console.log(`[Project Join/Create] Creating new project with projectId: ${userInputProjectId}`);
                isNew = true;
                const salt = await bcrypt.genSalt(10);
                const hashedPassword = await bcrypt.hash(password, salt);

                project = new Project({
                    projectId: userInputProjectId, // Store user input here as required by schema
                    password: hashedPassword,
                    users: [userId], // Add creator to the users array
                    // 'owner' field doesn't exist in schema
                    // 'name' field doesn't exist in schema (projectId seems to serve this purpose)
                    // 'code' field has a default in schema
                });
                needsSave = true;
            }
            // --- END CORRECTED LOGIC ---

            if (needsSave) {
                await project.save();
                 console.log(`[Project Join/Create] Project ${isNew ? 'created' : 'updated/joined'}. DB ID: ${project._id}, UserInputProjectId: ${project.projectId}`);
            }

            // --- CRITICAL: Respond with the actual MongoDB _id ---
            // The frontend needs the _id (ObjectId) for navigation and WS connection
            res.status(isNew ? 201 : 200).json({
                message: `Project ${isNew ? 'created' : 'joined'} successfully.`,
                // Send the DATABASE ID (_id) consistently, even though user deals with projectId field
                projectId: project._id.toString() // Send the unique DB ID
            });
            // --- END CRITICAL ---

        } catch (err) {
             // Handle potential duplicate key error for projectId if creating
             if (err.code === 11000 && err.keyPattern && err.keyPattern.projectId) {
                  console.warn(`[Project Join/Create] Attempted to create duplicate projectId: ${userInputProjectId}`);
                  return res.status(400).json({ errors: [{ msg: `Project ID '${userInputProjectId}' already exists.` }] });
             }
            console.error("Error in /join route:", err.message, err.stack);
            res.status(500).send('Server error');
        }
    }
);


// --- GET /api/projects (List projects for user) ---
router.get('/', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        // Find projects where the user's ID is in the 'users' array
        const projects = await Project.find({ users: userId })
                                      .select('projectId users createdAt _id') // Select relevant fields
                                      .sort({ createdAt: -1 });
        // Map response to send actual _id as projectId for consistency
        const responseProjects = projects.map(p => ({
            projectId: p._id.toString(), // Send DB ID
            name: p.projectId, // Send user-defined ID as name? Or keep it projectId? Depends on UI needs. Let's keep as projectId.
            userCount: p.users.length,
            createdAt: p.createdAt
        }));
        res.json(responseProjects);
    } catch (err) {
        console.error("Error fetching user's projects:", err.message, err.stack);
        res.status(500).send('Server error');
    }
});


// --- GET /api/projects/:projectId (Get single project details) ---
// NOTE: This route now expects the MongoDB ObjectId in the URL parameter
router.get(
    '/:projectId',
    authMiddleware,
    async (req, res) => {
        // This param is the MongoDB ObjectId (_id)
        const requestedObjectId = req.params.projectId;
        const userId = req.user.id;

        if (!mongoose.Types.ObjectId.isValid(requestedObjectId)) {
            return res.status(400).json({ msg: 'Invalid project ID format in URL' });
        }

        try {
            // Find project by its actual MongoDB _id
            const project = await Project.findById(requestedObjectId);
            if (!project) {
                return res.status(404).json({ msg: 'Project not found' });
            }
            // Authorization Check: Use the 'users' array
            if (!project.users?.includes(userId)) {
                 console.warn(`User ${userId} forbidden from accessing project ${requestedObjectId} via GET request.`);
                 return res.status(403).json({ msg: 'Forbidden: You do not have access to this project' });
            }
            // Return relevant, non-sensitive data
            res.json({
                 projectId: project._id.toString(), // Send the actual DB ID
                 userDefinedId: project.projectId, // Send the user-defined ID separately if needed
                 userCount: project.users?.length || 0,
                 createdAt: project.createdAt
             });
        } catch (err) {
            console.error(`Error fetching project ${requestedObjectId}:`, err.message, err.stack);
            res.status(500).send('Server error');
        }
    }
);

module.exports = router;