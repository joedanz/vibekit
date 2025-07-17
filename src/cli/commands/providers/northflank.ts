import { execa } from 'execa';
import ora from 'ora';
import chalk from 'chalk';
import { AGENT_TEMPLATES } from '../../../constants/enums.js';
import { isCliInstalled } from '../../utils/auth.js';
import { installTemplates, InstallConfig } from '../../utils/install.js';

// Map CPU/memory to Northflank deployment plans
function mapToNorthflankPlan(cpu: number, memory: number): string {
  // Basic mapping - can be refined based on actual Northflank plans
  if (cpu <= 1 && memory <= 1024) return 'nf-compute-50';
  if (cpu <= 2 && memory <= 2048) return 'nf-compute-100';
  if (cpu <= 4 && memory <= 4096) return 'nf-compute-200';
  return 'nf-compute-400'; // Default for higher specs
}

// Generate Northflank template for an agent
function generateNorthflankTemplate(templateName: string, config: InstallConfig) {
  const deploymentPlan = mapToNorthflankPlan(config.cpu, config.memory);
  
  return {
    "apiVersion": "v1.2",
    "name": `${templateName}-vibekit`,
    "description": `VibeKit ${templateName} development environment`,
    "spec": {
      "kind": "Workflow",
      "spec": {
        "type": "sequential",
        "steps": [
          {
            "kind": "Project",
            "ref": "project",
            "spec": {
              "name": `VibeKit-${templateName}`,
              "description": `VibeKit development environment for ${templateName}`,
              "region": "europe-west"
            }
          },
          {
            "kind": "Workflow",
            "spec": {
              "type": "sequential",
              "context": {
                "projectId": "${refs.project.id}"
              },
              "steps": [
                {
                  "kind": "CombinedService",
                  "ref": "service",
                  "spec": {
                    "name": `${templateName}-env`,
                    "billing": {
                      "deploymentPlan": deploymentPlan,
                      "buildPlan": "nf-compute-400-16"
                    },
                    "deployment": {
                      "instances": 1,
                      "storage": {
                        "ephemeralStorage": {
                          "storageSize": config.disk * 1024 // Convert GB to MB
                        }
                      }
                    },
                    "vcsData": {
                      "projectType": "github",
                      "projectUrl": "https://github.com/your-org/vibekit",
                      "projectBranch": "main"
                    },
                    "buildSettings": {
                      "dockerfile": {
                        "buildEngine": "kaniko",
                        "useCache": true,
                        "dockerWorkDir": "/",
                        "dockerFilePath": `/images/Dockerfile.${templateName}`,
                        "buildkit": {
                          "useInternalCache": true,
                          "internalCacheStorage": 16384
                        }
                      }
                    },
                    "ports": [
                      {
                        "name": "main",
                        "internalPort": 8080,
                        "public": true,
                        "protocol": "HTTP"
                      }
                    ]
                  }
                }
              ]
            }
          }
        ]
      }
    }
  };
}

export async function installNorthflank(config: InstallConfig, selectedTemplates?: string[]) {
  return installTemplates({
    provider: 'Northflank',
    cliCommand: 'northflank',
    isInstalled: async () => await isCliInstalled('northflank'),
    buildArgs: () => [], // Not used when customBuildLogic is provided
    needsTempFile: true, // We'll create template files instead of dockerfiles
    dockerfilePathPrefix: 'images/Dockerfile.',
    config,
    selectedTemplates,
    customBuildLogic: async (template: { name: string; display: string; message: string }, config: InstallConfig, tempDockerfile: string): Promise<boolean> => {
      // Custom logic for Northflank template deployment
      const fs = await import('fs/promises');
      
      // Generate template
      const templateContent = generateNorthflankTemplate(template.name, config);
      const templateFile = `${template.name}-template.json`;
      
      try {
        // Write template file
        await fs.writeFile(templateFile, JSON.stringify(templateContent, null, 2));
        
        // Run template
        await execa('northflank', ['run', 'template', templateFile]);
        
        // Clean up template file
        await fs.unlink(templateFile);
        
        return true;
      } catch (error) {
        // Clean up on error
        try {
          await fs.unlink(templateFile);
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
        throw error;
      }
    }
  });
} 